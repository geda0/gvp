import json
from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from app.models.models import Application, ApplyProfile, JobPosting
from app.services.resume_profile import load_resume_context, resolve_resume_path

DEFAULT_COVER_TEMPLATE = """Dear {{company}} hiring team,

I am writing regarding the {{role}} position{{location_phrase}}.

{{summary_line}}

Thank you for considering my application.

Best regards,
{{full_name}}
{{email_line}}"""


def get_or_create_profile(db: Session) -> ApplyProfile:
  row = db.query(ApplyProfile).filter_by(id=1).first()
  if row:
    return row
  row = ApplyProfile(id=1, learned_json={}, answers_defaults_json={})
  db.add(row)
  db.commit()
  db.refresh(row)
  return row


def profile_needs_setup(profile: ApplyProfile) -> list[str]:
  missing: list[str] = []
  if not (profile.full_name or '').strip():
    missing.append('full_name')
  if not (profile.email or '').strip():
    missing.append('email')
  return missing


def _render_template(tpl: str, ctx: dict[str, str]) -> str:
  out = tpl
  for k, v in ctx.items():
    out = out.replace('{{' + k + '}}', v)
  return out


def _summary_line_from_resume() -> str:
  ctx = load_resume_context()
  if ctx and ctx.summary:
    return ctx.summary
  return 'I bring experience building reliable software and collaborating across teams.'


def effective_cover_template(profile: ApplyProfile) -> str:
  t = (profile.cover_letter_template or '').strip()
  if t:
    return t
  return DEFAULT_COVER_TEMPLATE


def build_render_ctx(
  profile: ApplyProfile,
  job: JobPosting | None,
  company_name: str | None,
) -> dict[str, str]:
  role = job.title if job else 'this role'
  loc = (job.location or '').strip() if job else ''
  company = (company_name or 'the').strip() or 'the company'
  location_phrase = f' ({loc})' if loc else ''
  fn = (profile.full_name or 'Your name').strip()
  em = (profile.email or '').strip()
  email_line = f'\n{em}' if em else ''
  return {
    'company': company,
    'role': role,
    'location': loc,
    'location_phrase': location_phrase,
    'summary_line': _summary_line_from_resume(),
    'full_name': fn,
    'email_line': email_line,
  }


def render_cover_letter(profile: ApplyProfile, job: JobPosting | None, company_name: str | None) -> str:
  tpl = effective_cover_template(profile)
  ctx = build_render_ctx(profile, job, company_name)
  return _render_template(tpl, ctx).strip()


def merge_learned_answers(
  defaults: dict[str, Any] | None,
  learned: dict[str, Any] | None,
  current: dict[str, Any] | None,
) -> dict[str, Any]:
  learned_ans = {}
  if isinstance(learned, dict):
    learned_ans = learned.get('answers') or learned.get('answer_keys') or {}
  out = deepcopy(defaults) if isinstance(defaults, dict) else {}
  if isinstance(learned_ans, dict):
    out.update({k: v for k, v in learned_ans.items() if v not in (None, '')})
  cur = current if isinstance(current, dict) else {}
  merged = {**out, **cur}
  return merged


def fill_profile_into_answers(profile: ApplyProfile, answers: dict[str, Any]) -> dict[str, Any]:
  out = dict(answers)
  if profile.full_name and not out.get('full_name'):
    out['full_name'] = profile.full_name
  if profile.email and not out.get('email'):
    out['email'] = profile.email
  if profile.phone and not out.get('phone'):
    out['phone'] = profile.phone
  if profile.linkedin_url and not out.get('linkedin'):
    out['linkedin'] = profile.linkedin_url
  if profile.work_authorization and not out.get('work_authorization'):
    out['work_authorization'] = profile.work_authorization
  return out


def prepare_application_materials(db: Session, app: Application) -> Application:
  """Fill empty cover letter from template + resume; merge default/learned answers. Persists."""
  profile = get_or_create_profile(db)
  jp = app.job_posting
  co = jp.company if jp else None
  company_name = co.name if co else None
  learned = profile.learned_json if isinstance(profile.learned_json, dict) else {}
  defaults = profile.answers_defaults_json if isinstance(profile.answers_defaults_json, dict) else {}

  changed = False
  if not (app.cover_letter_text or '').strip():
    last = learned.get('last_cover_letter')
    ctx = build_render_ctx(profile, jp, company_name)
    if last and isinstance(last, str) and '{{' in last:
      text = _render_template(last, ctx).strip()
    else:
      text = render_cover_letter(profile, jp, company_name)
    if text:
      app.cover_letter_text = text
      changed = True

  merged = merge_learned_answers(defaults, learned, app.answers_json)
  merged = fill_profile_into_answers(profile, merged)
  if merged != (app.answers_json or {}):
    app.answers_json = merged
    changed = True

  if changed:
    db.add(app)
    db.commit()
    db.refresh(app)
  return app


def learn_from_submission(db: Session, app: Application) -> None:
  profile = get_or_create_profile(db)
  learned = dict(profile.learned_json or {})
  if (app.cover_letter_text or '').strip():
    learned['last_cover_letter'] = app.cover_letter_text.strip()
  ans = app.answers_json if isinstance(app.answers_json, dict) else {}
  prev = learned.get('answers')
  if not isinstance(prev, dict):
    prev = {}
  for k, v in ans.items():
    if v not in (None, ''):
      prev[str(k)] = v
  learned['answers'] = prev
  profile.learned_json = learned
  db.add(profile)
  db.commit()


def resume_available() -> bool:
  return resolve_resume_path() is not None
