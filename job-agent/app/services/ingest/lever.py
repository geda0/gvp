import httpx

from app.services.matcher import strip_html

LV_BASE = 'https://api.lever.co/v0/postings'


def fetch_lever_jobs(account_slug: str) -> list[dict]:
  url = f'{LV_BASE}/{account_slug}'
  params = {'mode': 'json'}
  headers = {'Accept': 'application/json'}
  with httpx.Client(timeout=30.0) as client:
    r = client.get(url, params=params, headers=headers)
    r.raise_for_status()
    data = r.json()
  if not isinstance(data, list):
    return []
  out: list[dict] = []
  for j in data:
    loc = j.get('categories', {}).get('location') if isinstance(j.get('categories'), dict) else None
    if not loc:
      loc = j.get('workplaceType')
    desc = j.get('descriptionPlain') or j.get('description') or ''
    apply_url = j.get('hostedUrl') or j.get('applyUrl') or ''
    out.append({
      'source': 'lever',
      'external_id': str(j.get('id', '')),
      'title': j.get('text') or 'Untitled',
      'location': str(loc) if loc else None,
      'absolute_url': apply_url,
      'content_snippet': strip_html(str(desc))[:2000],
      'raw_payload': j,
      'company_name': account_slug,
    })
  return out
