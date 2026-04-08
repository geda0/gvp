from fastapi import HTTPException, Request


def check_api_auth(request: Request) -> None:
  from app.config import get_settings

  if request.method == 'OPTIONS':
    return
  settings = get_settings()
  if not settings.api_key:
    return
  if request.url.path == '/health' or request.url.path.startswith('/static'):
    return
  h = request.headers.get('X-API-Key')
  q = request.query_params.get('api_key')
  if h == settings.api_key or q == settings.api_key:
    return
  raise HTTPException(status_code=401, detail='Missing or invalid API key')
