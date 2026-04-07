from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.models import Application, ApplicationEvent, JobPosting
from app.schemas.schemas import (
  ApplicationDetailOut,
  ApplicationEventCreate,
  ApplicationEventOut,
  ApplicationOut,
  ApplicationUpdate,
  JobPostingOut,
)
from app.services.sync import log_application_event

router = APIRouter(prefix='/api/applications', tags=['applications'])


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


@router.get('', response_model=list[ApplicationOut])
def list_applications(
  db: Session = Depends(get_db),
  status: str | None = None,
) -> list[Application]:
  q = db.query(Application).order_by(Application.updated_at.desc())
  if status:
    q = q.filter(Application.status == status)
  return q.limit(500).all()


@router.get('/{app_id}', response_model=ApplicationDetailOut)
def get_application(app_id: int, db: Session = Depends(get_db)) -> ApplicationDetailOut:
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404, detail='Application not found')
  jp = db.query(JobPosting).filter_by(id=app_row.job_posting_id).first()
  if not jp:
    raise HTTPException(status_code=404, detail='Job posting missing')
  events = (
    db.query(ApplicationEvent)
    .filter_by(application_id=app_row.id)
    .order_by(ApplicationEvent.created_at.asc())
    .all()
  )
  return ApplicationDetailOut(
    id=app_row.id,
    job_posting_id=app_row.job_posting_id,
    status=app_row.status,
    submitted_at=app_row.submitted_at,
    notes=app_row.notes,
    resume_version_id=app_row.resume_version_id,
    cover_letter_text=app_row.cover_letter_text,
    answers_json=app_row.answers_json,
    attachments_meta=app_row.attachments_meta,
    created_at=app_row.created_at,
    updated_at=app_row.updated_at,
    job_posting=JobPostingOut.model_validate(jp),
    events=[ApplicationEventOut.model_validate(e) for e in events],
  )


@router.patch('/{app_id}', response_model=ApplicationOut)
def update_application(
  app_id: int,
  body: ApplicationUpdate,
  db: Session = Depends(get_db),
) -> Application:
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404, detail='Application not found')
  old_status = app_row.status
  data = body.model_dump(exclude_unset=True)
  for k, v in data.items():
    setattr(app_row, k, v)
  app_row.updated_at = utcnow()
  if 'status' in data and data['status'] != old_status:
    log_application_event(
      db,
      app_row,
      'status_change',
      {'from': old_status, 'to': data['status']},
    )
  db.commit()
  db.refresh(app_row)
  return app_row


@router.post('/{app_id}/events', response_model=ApplicationEventOut)
def add_event(
  app_id: int,
  body: ApplicationEventCreate,
  db: Session = Depends(get_db),
) -> ApplicationEvent:
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404, detail='Application not found')
  ev = log_application_event(db, app_row, body.event_type, body.payload)
  db.commit()
  db.refresh(ev)
  return ev
