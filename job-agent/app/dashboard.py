import json
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload

from app.config import get_settings
from app.database import get_db
from app.models.models import Application, ApplicationStatus, JobPosting
from app.services.apply_materials import (
  get_or_create_profile,
  learn_from_submission,
  prepare_application_materials,
  profile_needs_setup,
)
from app.services.resume_profile import resume_available
from app.services.sync import log_application_event, run_sync, utcnow

BASE_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / 'templates'))


def _tojson_filter(value, indent=None):
  if value is None:
    return ''
  kwargs: dict = {'default': str}
  if indent is not None:
    kwargs['indent'] = int(indent)
  return json.dumps(value, **kwargs)


templates.env.filters['tojson'] = _tojson_filter

router = APIRouter(tags=['dashboard'])


def _ctx(request: Request, **extra):
  s = get_settings()
  return {
    'request': request,
    'api_key': s.api_key or '',
    'public_base_url': (s.public_base_url or '').rstrip('/'),
    **extra,
  }


@router.get('/', response_class=HTMLResponse)
def dashboard_home(request: Request):
  return templates.TemplateResponse(
    'index.html',
    _ctx(request, resume_loaded=resume_available()),
  )


@router.get('/apply', response_class=HTMLResponse)
def linkedin_apply_dashboard(
  request: Request,
  db: Session = Depends(get_db),
  show_all: bool = Query(default=False),
):
  settings = get_settings()
  t = settings.match_score_threshold
  q = (
    db.query(JobPosting)
    .options(joinedload(JobPosting.company))
    .filter(JobPosting.source == 'linkedin')
    .filter(JobPosting.user_dismissed == False)  # noqa: E712
  )
  if not show_all:
    q = q.outerjoin(Application, Application.job_posting_id == JobPosting.id).filter(Application.id.is_(None))
  rows = q.order_by(JobPosting.match_score.desc()).limit(200).all()
  jobs_above = [j for j in rows if (j.match_score or 0) >= t]
  jobs_below = [j for j in rows if (j.match_score or 0) < t]
  return templates.TemplateResponse(
    'apply_dashboard.html',
    _ctx(
      request,
      jobs=rows,
      jobs_above=jobs_above,
      jobs_below=jobs_below,
      threshold=t,
      show_all=show_all,
      resume_loaded=resume_available(),
    ),
  )


@router.post('/apply/{job_id}/dismiss')
def apply_dismiss_linkedin(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id, source='linkedin').first()
  if not jp:
    raise HTTPException(status_code=404)
  jp.user_dismissed = True
  db.commit()
  return RedirectResponse(url='/apply', status_code=303)


@router.post('/apply/{job_id}/shortlist')
def apply_shortlist_linkedin(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id, source='linkedin').first()
  if not jp:
    raise HTTPException(status_code=404)
  existing = db.query(Application).filter_by(job_posting_id=jp.id).first()
  if existing:
    return RedirectResponse(url=f'/applications/{existing.id}/apply', status_code=303)
  app_row = Application(job_posting_id=jp.id, status=ApplicationStatus.preparing.value)
  db.add(app_row)
  db.flush()
  log_application_event(db, app_row, 'created', {'from': 'linkedin_apply_dashboard'})
  db.commit()
  return RedirectResponse(url=f'/applications/{app_row.id}/apply', status_code=303)


@router.get('/queue', response_class=HTMLResponse)
def queue_page(request: Request, db: Session = Depends(get_db)):
  settings = get_settings()
  t = settings.match_score_threshold
  rows = (
    db.query(JobPosting)
    .options(joinedload(JobPosting.company))
    .outerjoin(Application, Application.job_posting_id == JobPosting.id)
    .filter(JobPosting.user_dismissed == False)  # noqa: E712
    .filter(Application.id.is_(None))
    .filter(JobPosting.match_score >= t)
    .order_by(JobPosting.match_score.desc())
    .limit(200)
    .all()
  )
  return templates.TemplateResponse(
    'queue.html',
    _ctx(request, jobs=rows, threshold=t, resume_loaded=resume_available()),
  )


@router.post('/queue/{job_id}/dismiss')
def queue_dismiss(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404)
  jp.user_dismissed = True
  db.commit()
  return RedirectResponse(url='/queue', status_code=303)


@router.post('/queue/{job_id}/shortlist')
def queue_shortlist(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404)
  existing = db.query(Application).filter_by(job_posting_id=jp.id).first()
  if existing:
    return RedirectResponse(url=f'/applications/{existing.id}/apply', status_code=303)
  app_row = Application(job_posting_id=jp.id, status=ApplicationStatus.preparing.value)
  db.add(app_row)
  db.flush()
  log_application_event(db, app_row, 'created', {'from': 'shortlist'})
  db.commit()
  return RedirectResponse(url=f'/applications/{app_row.id}/apply', status_code=303)


@router.get('/applications', response_class=HTMLResponse)
def applications_list(request: Request, db: Session = Depends(get_db)):
  rows = (
    db.query(Application)
    .options(joinedload(Application.job_posting).joinedload(JobPosting.company))
    .order_by(Application.updated_at.desc())
    .limit(200)
    .all()
  )
  return templates.TemplateResponse('applications.html', _ctx(request, applications=rows))


@router.get('/applications/{app_id}', response_class=HTMLResponse)
def application_detail(request: Request, app_id: int, db: Session = Depends(get_db)):
  app_row = (
    db.query(Application)
    .options(
      joinedload(Application.job_posting).joinedload(JobPosting.company),
      joinedload(Application.events),
    )
    .filter_by(id=app_id)
    .first()
  )
  if not app_row:
    raise HTTPException(status_code=404)
  return templates.TemplateResponse('application_detail.html', _ctx(request, app_row=app_row))


def _apply_payload_json(app_row: Application) -> str:
  jp = app_row.job_posting
  co = jp.company if jp else None
  payload = {
    'jobUrl': jp.absolute_url if jp else '',
    'coverLetter': app_row.cover_letter_text or '',
    'answers': app_row.answers_json,
    'title': jp.title if jp else '',
    'company': co.name if co else '',
    'resumeVersionId': app_row.resume_version_id or '',
  }
  raw = json.dumps(payload, default=str)
  return raw.replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


@router.get('/applications/{app_id}/apply', response_class=HTMLResponse)
def application_apply_workspace(request: Request, app_id: int, db: Session = Depends(get_db)):
  app_row = (
    db.query(Application)
    .options(joinedload(Application.job_posting).joinedload(JobPosting.company))
    .filter_by(id=app_id)
    .first()
  )
  if not app_row:
    raise HTTPException(status_code=404)
  profile = get_or_create_profile(db)
  prepare_application_materials(db, app_row)
  db.refresh(app_row)
  needs = profile_needs_setup(profile)
  apply_payload = _apply_payload_json(app_row)
  autorun = request.query_params.get('autorun') == '1'
  return templates.TemplateResponse(
    'apply.html',
    _ctx(
      request,
      app_row=app_row,
      apply_payload=apply_payload,
      profile=profile,
      needs_setup=needs,
      resume_loaded=resume_available(),
      autorun=autorun,
    ),
  )


@router.post('/applications/{app_id}/apply/bootstrap')
def application_apply_bootstrap(
  app_id: int,
  db: Session = Depends(get_db),
  full_name: str = Form(''),
  email: str = Form(''),
  phone: str | None = Form(None),
  linkedin_url: str | None = Form(None),
  work_authorization: str | None = Form(None),
  cover_letter_template: str | None = Form(None),
):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404)
  if not full_name.strip() or not email.strip():
    return RedirectResponse(url=f'/applications/{app_id}/apply?setup_error=1', status_code=303)
  profile = get_or_create_profile(db)
  profile.full_name = full_name.strip()
  profile.email = email.strip()
  profile.phone = (phone or '').strip() or None
  profile.linkedin_url = (linkedin_url or '').strip() or None
  profile.work_authorization = (work_authorization or '').strip() or None
  if cover_letter_template is not None and cover_letter_template.strip():
    profile.cover_letter_template = cover_letter_template
  db.add(profile)
  db.commit()
  prepare_application_materials(db, app_row)
  return RedirectResponse(url=f'/applications/{app_id}/apply?autorun=1', status_code=303)


@router.get('/profile', response_class=HTMLResponse)
def profile_page(request: Request, db: Session = Depends(get_db)):
  profile = get_or_create_profile(db)
  ad = profile.answers_defaults_json if isinstance(profile.answers_defaults_json, dict) else {}
  return templates.TemplateResponse(
    'profile.html',
    _ctx(
      request,
      profile=profile,
      answers_defaults_json=json.dumps(ad, indent=2, default=str),
      resume_loaded=resume_available(),
    ),
  )


@router.post('/profile')
def profile_save(
  db: Session = Depends(get_db),
  full_name: str = Form(''),
  email: str = Form(''),
  phone: str | None = Form(None),
  linkedin_url: str | None = Form(None),
  work_authorization: str | None = Form(None),
  cover_letter_template: str | None = Form(None),
  answers_defaults_json: str | None = Form(None),
):
  profile = get_or_create_profile(db)
  profile.full_name = full_name.strip()
  profile.email = email.strip()
  profile.phone = (phone or '').strip() or None
  profile.linkedin_url = (linkedin_url or '').strip() or None
  profile.work_authorization = (work_authorization or '').strip() or None
  profile.cover_letter_template = cover_letter_template
  if answers_defaults_json and answers_defaults_json.strip():
    try:
      profile.answers_defaults_json = json.loads(answers_defaults_json)
    except json.JSONDecodeError:
      pass
  else:
    profile.answers_defaults_json = {}
  db.add(profile)
  db.commit()
  return RedirectResponse(url='/profile?saved=1', status_code=303)


@router.post('/applications/{app_id}/mark-submitted')
def application_mark_submitted(app_id: int, db: Session = Depends(get_db)):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404)
  old = app_row.status
  app_row.status = ApplicationStatus.submitted.value
  if not app_row.submitted_at:
    app_row.submitted_at = utcnow()
  app_row.updated_at = utcnow()
  if old != ApplicationStatus.submitted.value:
    log_application_event(db, app_row, 'status_change', {'from': old, 'to': ApplicationStatus.submitted.value})
  db.commit()
  db.refresh(app_row)
  learn_from_submission(db, app_row)
  return RedirectResponse(url=f'/applications/{app_id}/apply?marked=1', status_code=303)


@router.post('/applications/{app_id}/update')
def application_update(
  app_id: int,
  db: Session = Depends(get_db),
  status: str = Form(...),
  notes: str | None = Form(None),
  cover_letter_text: str | None = Form(None),
  submitted_at: str | None = Form(None),
):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404)
  old = app_row.status
  app_row.status = status
  app_row.notes = notes
  app_row.cover_letter_text = cover_letter_text
  if submitted_at:
    try:
      from datetime import datetime
      app_row.submitted_at = datetime.fromisoformat(submitted_at.replace('Z', '+00:00'))
    except ValueError:
      pass
  elif status == ApplicationStatus.submitted.value and not app_row.submitted_at:
    app_row.submitted_at = utcnow()
  app_row.updated_at = utcnow()
  if old != status:
    log_application_event(db, app_row, 'status_change', {'from': old, 'to': status})
  db.commit()
  return RedirectResponse(url=f'/applications/{app_id}', status_code=303)


@router.post('/applications/{app_id}/event')
def application_add_event(
  app_id: int,
  db: Session = Depends(get_db),
  event_type: str = Form(...),
  note: str | None = Form(None),
):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404)
  log_application_event(db, app_row, event_type, {'note': note} if note else None)
  db.commit()
  return RedirectResponse(url=f'/applications/{app_id}', status_code=303)


@router.post('/sync')
def dashboard_sync(db: Session = Depends(get_db)):
  run_sync(db)
  return RedirectResponse(url='/', status_code=303)
