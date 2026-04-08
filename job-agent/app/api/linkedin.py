from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from starlette.responses import Response

from app.database import get_db
from app.models.models import Company, JobPosting
from app.schemas.schemas import LinkedInCaptureIn, LinkedInCaptureOut
from app.services.linkedin_ingest import linkedin_external_id, normalize_linkedin_job_url
from app.services.matcher import score_job_text
from app.services.resume_profile import load_resume_context
from app.services.sync import utcnow

router = APIRouter(prefix='/api/linkedin', tags=['linkedin'])


@router.options('/capture')
def capture_preflight():
  return Response(status_code=204)


def _ensure_linkedin_company(db: Session, employer_name: str) -> Company:
  name = (employer_name or 'Unknown employer').strip()[:500] or 'Unknown employer'
  c = db.query(Company).filter_by(ats_type='linkedin', name=name).first()
  if c:
    return c
  c = Company(name=name, ats_type='linkedin')
  db.add(c)
  db.flush()
  return c


@router.post('/capture', response_model=LinkedInCaptureOut)
def capture_linkedin_job(body: LinkedInCaptureIn, db: Session = Depends(get_db)) -> LinkedInCaptureOut:
  try:
    norm = normalize_linkedin_job_url(body.url)
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e)) from e
  ext = linkedin_external_id(norm)
  title = (body.title or 'LinkedIn job').strip()[:1024] or 'LinkedIn job'
  snippet = (body.snippet or '').strip()[:8000] or None
  resume_ctx = load_resume_context()
  score, reasons = score_job_text(title, snippet, None, resume_ctx=resume_ctx)

  co = _ensure_linkedin_company(db, body.company or '')
  now = utcnow()
  raw = {'url': norm, 'client_title': body.title, 'client_company': body.company}
  jp = db.query(JobPosting).filter_by(source='linkedin', external_id=ext).one_or_none()
  if jp:
    jp.last_seen = now
    jp.title = title
    jp.absolute_url = norm
    jp.content_snippet = snippet
    jp.raw_payload = raw
    jp.company_id = co.id
    jp.match_score = score
    jp.match_reasons = reasons
  else:
    jp = JobPosting(
      company_id=co.id,
      source='linkedin',
      external_id=ext,
      title=title,
      location=None,
      absolute_url=norm,
      content_snippet=snippet,
      raw_payload=raw,
      first_seen=now,
      last_seen=now,
      match_score=score,
      match_reasons=reasons,
      user_dismissed=False,
    )
    db.add(jp)
  db.commit()
  db.refresh(jp)
  return LinkedInCaptureOut(
    job_posting_id=jp.id,
    match_score=jp.match_score,
    match_reasons=jp.match_reasons,
    external_id=ext,
  )
