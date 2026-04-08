import csv
import io

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.models import Application, JobPosting

router = APIRouter(prefix='/api/export', tags=['export'])


@router.get('/applications.csv')
def export_applications_csv(db: Session = Depends(get_db)) -> Response:
  rows = (
    db.query(Application)
    .options(joinedload(Application.job_posting).joinedload(JobPosting.company))
    .order_by(Application.id.asc())
    .all()
  )
  buf = io.StringIO()
  w = csv.writer(buf)
  w.writerow([
    'application_id', 'status', 'submitted_at', 'title', 'company', 'location', 'url', 'source', 'notes',
    'created_at', 'updated_at',
  ])
  for a in rows:
    jp = a.job_posting
    co = jp.company if jp else None
    w.writerow([
      a.id, a.status,
      a.submitted_at.isoformat() if a.submitted_at else '',
      jp.title if jp else '',
      co.name if co else '',
      jp.location if jp else '',
      jp.absolute_url if jp else '',
      jp.source if jp else '',
      (a.notes or '').replace('\n', ' '),
      a.created_at.isoformat() if a.created_at else '',
      a.updated_at.isoformat() if a.updated_at else '',
    ])
  return Response(
    content=buf.getvalue(),
    media_type='text/csv',
    headers={'Content-Disposition': 'attachment; filename="applications.csv"'},
  )
