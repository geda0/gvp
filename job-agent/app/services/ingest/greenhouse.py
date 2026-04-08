import httpx

from app.services.matcher import strip_html

GH_BASE = 'https://boards-api.greenhouse.io/v1/boards'


def fetch_greenhouse_jobs(board_token: str) -> list[dict]:
  url = f'{GH_BASE}/{board_token}/jobs'
  with httpx.Client(timeout=30.0) as client:
    r = client.get(url)
    r.raise_for_status()
    data = r.json()
  jobs = data.get('jobs') or []
  out: list[dict] = []
  for j in jobs:
    loc = j.get('location') or {}
    loc_name = loc.get('name') if isinstance(loc, dict) else None
    content = j.get('content') or ''
    out.append({
      'source': 'greenhouse',
      'external_id': str(j.get('id', '')),
      'title': j.get('title') or 'Untitled',
      'location': loc_name,
      'absolute_url': j.get('absolute_url') or '',
      'content_snippet': strip_html(content)[:2000],
      'raw_payload': j,
      'company_name': j.get('company_name') or board_token,
    })
  return out
