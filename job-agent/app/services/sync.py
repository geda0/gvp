from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.models import Application, ApplicationEvent, Company, JobPosting
from app.services.ingest import fetch_greenhouse_jobs, fetch_lever_jobs
from app.services.matcher import score_job_text
from app.services.resume_profile import load_resume_context


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


def _ensure_company_greenhouse(db: Session, board_token: str, display_name: str | None) -> Company:
  c = db.query(Company).filter_by(ats_type='greenhouse', board_token=board_token).first()
  if c:
    if display_name and c.name == board_token:
      c.name = display_name
    return c
  c = Company(
    name=display_name or board_token,
    ats_type='greenhouse',
    board_token=board_token,
  )
  db.add(c)
  db.flush()
  return c


def _ensure_company_lever(db: Session, slug: str) -> Company:
  c = db.query(Company).filter_by(ats_type='lever', lever_slug=slug).first()
  if c:
    return c
  c = Company(name=slug, ats_type='lever', lever_slug=slug)
  db.add(c)
  db.flush()
  return c


def _upsert_posting(db: Session, company: Company, row: dict, resume_ctx) -> JobPosting:
  jp = db.query(JobPosting).filter_by(source=row['source'], external_id=row['external_id']).one_or_none()
  now = utcnow()
  score, reasons = score_job_text(row['title'], row.get('content_snippet'), row.get('location'), resume_ctx=resume_ctx)
  if jp:
    jp.last_seen = now
    jp.title = row['title']
    jp.location = row.get('location')
    jp.absolute_url = row['absolute_url'] or jp.absolute_url
    jp.content_snippet = row.get('content_snippet')
    jp.raw_payload = row.get('raw_payload')
    jp.company_id = company.id
    jp.match_score = score
    jp.match_reasons = reasons
    return jp
  jp = JobPosting(
    company_id=company.id,
    source=row['source'],
    external_id=row['external_id'],
    title=row['title'],
    location=row.get('location'),
    absolute_url=row.get('absolute_url') or '',
    content_snippet=row.get('content_snippet'),
    raw_payload=row.get('raw_payload'),
    first_seen=now,
    last_seen=now,
    match_score=score,
    match_reasons=reasons,
    user_dismissed=False,
  )
  db.add(jp)
  db.flush()
  return jp


def run_sync(db: Session) -> dict:
  settings = get_settings()
  stats: dict = {'greenhouse_jobs': 0, 'lever_jobs': 0, 'errors': []}
  resume_ctx = load_resume_context()

  for token in settings.greenhouse_tokens_list:
    try:
      rows = fetch_greenhouse_jobs(token)
      company_name = rows[0]['company_name'] if rows else None
      co = _ensure_company_greenhouse(db, token, company_name)
      for row in rows:
        _upsert_posting(db, co, row, resume_ctx)
        stats['greenhouse_jobs'] += 1
    except Exception as e:
      stats['errors'].append(f'greenhouse:{token}: {e!s}')

  for slug in settings.lever_slugs_list:
    try:
      rows = fetch_lever_jobs(slug)
      co = _ensure_company_lever(db, slug)
      if rows:
        co.name = slug
      for row in rows:
        row['company_name'] = slug
        _upsert_posting(db, co, row, resume_ctx)
        stats['lever_jobs'] += 1
    except Exception as e:
      stats['errors'].append(f'lever:{slug}: {e!s}')

  db.commit()
  return stats


def log_application_event(
  db: Session,
  application: Application,
  event_type: str,
  payload: dict | None = None,
) -> ApplicationEvent:
  ev = ApplicationEvent(application_id=application.id, event_type=event_type, payload=payload)
  db.add(ev)
  return ev
