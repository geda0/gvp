import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import get_settings


@dataclass
class ResumeMatchContext:
  skills: list[str] = field(default_factory=list)
  summary: str = ''
  experience_roles: list[str] = field(default_factory=list)
  education_phrases: list[str] = field(default_factory=list)
  raw: dict[str, Any] = field(default_factory=dict)


def resolve_resume_path() -> Path | None:
  settings = get_settings()
  if getattr(settings, 'profile_json_path', None):
    p = Path(settings.profile_json_path).expanduser()
    if p.is_file():
      return p
  base = Path(__file__).resolve().parents[2]
  for candidate in (
    base.parent / 'resume' / 'resume.json',
    base / 'data' / 'resume.json',
  ):
    if candidate.is_file():
      return candidate
  return None


def load_resume_context() -> ResumeMatchContext | None:
  path = resolve_resume_path()
  if not path:
    return None
  try:
    data = json.loads(path.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError):
    return None
  ctx = ResumeMatchContext(raw=data)
  ctx.summary = (data.get('summary') or '').strip()
  ctx.skills = [str(s).strip() for s in (data.get('skills') or []) if str(s).strip()]
  for exp in data.get('experience') or []:
    if isinstance(exp, dict) and exp.get('role'):
      ctx.experience_roles.append(str(exp['role']))
  for edu in data.get('education') or []:
    if isinstance(edu, dict):
      parts = [edu.get('degree'), edu.get('school')]
      ctx.education_phrases.append(' '.join(p for p in parts if p))
  return ctx


def skill_matches_text(skill: str, text: str) -> bool:
  sl = skill.lower().strip()
  tl = text.lower()
  if len(sl) <= 2:
    return sl in tl
  if sl in tl:
    return True
  for w in sl.replace('/', ' ').replace('-', ' ').split():
    w = w.strip()
    if len(w) > 2 and w in tl:
      return True
  return False


def resume_overlap_reasons(ctx: ResumeMatchContext, text: str) -> tuple[int, list[str]]:
  reasons: list[str] = []
  pts = 0
  seen: set[str] = set()
  for s in ctx.skills:
    if skill_matches_text(s, text) and s not in seen:
      seen.add(s)
      add = min(12, 6 + len(s) // 15)
      pts += add
      reasons.append(f'resume skill "{s}" (+{add})')
  for role in ctx.experience_roles[:8]:
    rl = role.lower()
    if len(rl) > 4 and rl in text.lower():
      pts += 5
      reasons.append('resume role overlap (+5)')
      break
  if ctx.summary and len(ctx.summary) > 10:
    sw = ctx.summary.lower().split()[:12]
    hits = sum(1 for w in sw if len(w) > 4 and w in text.lower())
    if hits >= 2:
      pts += 8
      reasons.append('summary keyword overlap (+8)')
  return pts, reasons
