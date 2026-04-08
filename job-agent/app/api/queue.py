from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models.models import Application, JobPosting

router = APIRouter(prefix='/api/queue', tags=['queue'])


@router.get('')
def review_queue(
  db: Session = Depends(get_db),
  threshold: int | None = Query(default=None),
):
  settings = get_settings()
  t = threshold if threshold is not None else settings.match_score_threshold
  q = (
    db.query(JobPosting)
    .outerjoin(Application, Application.job_posting_id == JobPosting.id)
    .filter(JobPosting.user_dismissed == False)  # noqa: E712
    .filter(Application.id.is_(None))
    .filter(JobPosting.match_score >= t)
    .order_by(JobPosting.match_score.desc())
  )
  return q.limit(200).all()
