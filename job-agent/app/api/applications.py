from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.models import Application, ApplicationEvent, JobPosting
from app.services.sync import log_application_event

router = APIRouter(prefix='/api/applications', tags=['applications'])


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


@router.get('')
def list_applications(db: Session = Depends(get_db), status: str | None = None):
  q = db.query(Application).order_by(Application.updated_at.desc())
  if status:
    q = q.filter(Application.status == status)
  return q.limit(500).all()


@router.get('/{app_id}')
def get_application(app_id: int, db: Session = Depends(get_db)):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404, detail='Application not found')
  jp = db.query(JobPosting).filter_by(id=app_row.job_posting_id).first()
  events = db.query(ApplicationEvent).filter_by(application_id=app_row.id).order_by(ApplicationEvent.created_at.asc()).all()
  return {'application': app_row, 'job_posting': jp, 'events': events}


@router.patch('/{app_id}')
def patch_application(app_id: int, db: Session = Depends(get_db), body: dict = Body(default_factory=dict)):
  app_row = db.query(Application).filter_by(id=app_id).first()
  if not app_row:
    raise HTTPException(status_code=404, detail='Application not found')
  if body:
    for k, v in body.items():
      if hasattr(app_row, k):
        setattr(app_row, k, v)
    app_row.updated_at = utcnow()
  db.commit()
  db.refresh(app_row)
  return app_row
