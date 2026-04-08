import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import Application, Company, JobPosting
from app.services.matcher import score_job_text
from app.services.resume_profile import load_resume_context
from app.services.sync import utcnow

router = APIRouter(prefix='/api/jobs', tags=['jobs'])


class ManualJobCreate(BaseModel):
  company_name: str
  title: str
  absolute_url: str
  location: str | None = None
  content_snippet: str | None = None


@router.get('')
def list_jobs(
  db: Session = Depends(get_db),
  dismissed: bool | None = None,
  min_score: int | None = None,
  q: str | None = None,
):
  stmt = db.query(JobPosting)
  if dismissed is not None:
    stmt = stmt.filter(JobPosting.user_dismissed == dismissed)
  if min_score is not None:
    stmt = stmt.filter(JobPosting.match_score >= min_score)
  if q:
    like = f'%{q}%'
    stmt = stmt.filter(or_(JobPosting.title.ilike(like), JobPosting.content_snippet.ilike(like)))
  return stmt.order_by(JobPosting.last_seen.desc()).limit(500).all()


@router.get('/{job_id}')
def get_job(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  return jp


@router.post('/{job_id}/dismiss')
def dismiss_job(job_id: int, db: Session = Depends(get_db)):
  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  jp.user_dismissed = True
  db.commit()
  return {'ok': True}


@router.post('/{job_id}/shortlist')
def shortlist_job(job_id: int, db: Session = Depends(get_db)):
  from app.models.models import ApplicationStatus
  from app.services.sync import log_application_event

  jp = db.query(JobPosting).filter_by(id=job_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job not found')
  existing = db.query(Application).filter_by(job_posting_id=jp.id).first()
  if existing:
    return {'ok': True, 'application_id': existing.id, 'message': 'Already in pipeline'}
  app_row = Application(job_posting_id=jp.id, status=ApplicationStatus.preparing.value)
  db.add(app_row)
  db.flush()
  log_application_event(db, app_row, 'created', {'from': 'shortlist'})
  db.commit()
  db.refresh(app_row)
  return {'ok': True, 'application_id': app_row.id}


@router.post('/manual')
def create_manual_job(body: ManualJobCreate, db: Session = Depends(get_db)):
  company_name = body.company_name
  title = body.title
  absolute_url = body.absolute_url
  location = body.location
  content_snippet = body.content_snippet
  co = db.query(Company).filter_by(ats_type='manual', name=company_name).first()
  if not co:
    co = Company(name=company_name, ats_type='manual')
    db.add(co)
    db.flush()
  score, reasons = score_job_text(
    title,
    content_snippet,
    location,
    resume_ctx=load_resume_context(),
  )
  jp = JobPosting(
    company_id=co.id,
    source='manual',
    external_id=f'manual-{uuid.uuid4().hex[:16]}',
    title=title,
    location=location,
    absolute_url=absolute_url,
    content_snippet=content_snippet,
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
