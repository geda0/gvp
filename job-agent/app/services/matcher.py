import json
import re
from pathlib import Path
from typing import Any

from app.services.resume_profile import ResumeMatchContext, resume_overlap_reasons, skill_matches_text


def _default_rules() -> dict[str, Any]:
  return {
    'must_have_any': [
      'engineer', 'developer', 'software', 'swe ', ' swe', 'backend', 'frontend',
      'full stack', 'fullstack', 'devops', 'ml ', ' data',
    ],
    'boost_keywords': {
      'python': 12,
      'typescript': 10,
      'react': 8,
      'kubernetes': 8,
      'distributed': 6,
      'api': 4,
    },
    'block_title_substrings': ['sales intern', 'marketing intern'],
    'remote_boost': 8,
    'location_boost_substrings': ['remote', 'san francisco', 'new york', 'nyc'],
  }


def load_matcher_rules() -> dict[str, Any]:
  base = Path(__file__).resolve().parents[2]
  path = base / 'data' / 'matcher_rules.json'
  if path.is_file():
    try:
      return json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
      pass
  example = base / 'data' / 'matcher_rules.example.json'
  if example.is_file():
    try:
      return json.loads(example.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
      pass
  return _default_rules()


def score_job_text(
  title: str,
  snippet: str | None,
  location: str | None,
  resume_ctx: ResumeMatchContext | None = None,
) -> tuple[int, list[str]]:
  rules = load_matcher_rules()
  text = f'{title}\n{snippet or ""}\n{location or ""}'.lower()
  full_text_for_resume = f'{title}\n{snippet or ""}\n{location or ""}'
  reasons: list[str] = []
  score = 0

  block = rules.get('block_title_substrings') or []
  tl = title.lower()
  for b in block:
    if b.lower() in tl:
      return 0, [f'blocked title: contains "{b}"']

  must_any = rules.get('must_have_any') or []
  if must_any:
    resume_ok = False
    if resume_ctx and resume_ctx.skills:
      resume_ok = any(skill_matches_text(s, full_text_for_resume) for s in resume_ctx.skills)
    if not resume_ok and not any(k.lower() in text for k in must_any):
      return 5, ['no keyword match from must_have_any (and no resume skill hit)']

  boosts = rules.get('boost_keywords') or {}
  for kw, pts in boosts.items():
    if kw.lower() in text:
      score += int(pts)
      reasons.append(f'keyword "{kw}" (+{pts})')

  loc_boosts = rules.get('location_boost_substrings') or []
  rb = int(rules.get('remote_boost') or 0)
  loc_blob = f'{location or ""}'.lower()
  for loc in loc_boosts:
    if loc.lower() in loc_blob or loc.lower() in text:
      score += rb
      reasons.append(f'location/remote hint "{loc}" (+{rb})')
      break

  if resume_ctx and resume_ctx.skills:
    rp, rreasons = resume_overlap_reasons(resume_ctx, full_text_for_resume.lower())
    rp = min(rp, 45)
    score += rp
    reasons.extend(rreasons)
    any_skill = any(skill_matches_text(s, full_text_for_resume) for s in resume_ctx.skills)
    if not any_skill:
      reasons.append('no overlap with resume skills (capped)')
      score = min(score, 22)

  base = 20
  score = min(100, base + score)
  if not reasons:
    reasons.append('base match')
  return score, reasons


def strip_html(html: str | None, max_len: int = 2000) -> str:
  if not html:
    return ''
  text = re.sub(r'<[^>]+>', ' ', html)
  text = re.sub(r'\s+', ' ', text).strip()
  return text[:max_len]
