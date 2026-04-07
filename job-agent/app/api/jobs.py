import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import Application, Company, JobPosting
from app.schemas.schemas import JobPostingOut, ManualJobCreate
from app.services.matcher import score_job_text
from app.services.resume_profile import load_resume_context
from app.services.sync import utcnow

router = APIRouter(prefix='/api/jobs', tags=['jobs'])


@router.get('', response_model=list[JobPostingOut])
def list_jobs(
  db: Session = Depends(get_db),
  dismissed: bool | None = None,
  min_score: int | None = None,
  q: str | None = None,
) -> list[JobPosting]:
  stmt = db.query(JobPosting)
  if dismissed is not None:
    stmt = stmt.filter(JobPosting.user_dismissed == dismissed)
  if min_score is not None:
    stmt = stmt.filter(JobPosting.match_score >= min_score)
  if q:
    like = f'%{q}%'
    stmt = stmt.filter(or_(JobPosting.title.ilike(like), JobPosting.content_snippet.ilike(like)))
  return stmt.order_by(JobPosting.last_seen.desc()).limit(500).all()


@router.get('/{job_id}', response_model=JobPostingOut)
def get_job(job_id: int, db: Session = Depends(get_db)) -> JobPosting:
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  return jp


@router.post('/{job_id}/dismiss')
def dismiss_job(job_id: int, db: Session = Depends(get_db)) -> dict:
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  jp.user_dismissed = True
  db.commit()
  return {'ok': True}


@router.post('/{job_id}/shortlist', response_model=dict)
def shortlist_job(job_id: int, db: Session = Depends(get_db)) -> dict:
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  existing = db.query(Application).filter_by(job_posting_id=jp.id).first()
  if existing:
    return {'ok': True, 'application_id': existing.id, 'message': 'Already in pipeline'}
  from app.models.models import ApplicationStatus
  from app.services.sync import log_application_event

  app_row = Application(job_posting_id=jp.id, status=ApplicationStatus.preparing.value)
  db.add(app_row)
  db.flush()
  log_application_event(db, app_row, 'created', {'from': 'shortlist'})
  db.commit()
  db.refresh(app_row)
  return {'ok': True, 'application_id': app_row.id}


@router.post('/manual', response_model=JobPostingOut)
def create_manual_job(body: ManualJobCreate, db: Session = Depends(get_db)) -> JobPosting:
  co = db.query(Company).filter_by(ats_type='manual', name=body.company_name).first()
  if not co:
    co = Company(name=body.company_name, ats_type='manual')
    db.add(co)
    db.flush()
  score, reasons = score_job_text(
    body.title,
    body.content_snippet,
    body.location,
    resume_ctx=load_resume_context(),
  )
  jp = JobPosting(
    company_id=co.id,
    source='manual',
    external_id=f'manual-{uuid.uuid4().hex[:16]}',
    title=body.title,
    location=body.location,
    absolute_url=body.absolute_url,
    content_snippet=body.content_snippet,
    first_seen=utcnow(),
    last_seen=utcnow(),
    match_score=score,
    match_reasons=reasons,
    user_dismissed=False,
  )
  db.add(jp)
  db.commit()
  db.refresh(jp)
  return jp
