from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from app.api.applications import router as applications_router
from app.api.companies import router as companies_router
from app.api.deps import check_api_auth
from app.api.export import router as export_router
from app.api.jobs import router as jobs_router
from app.api.linkedin import router as linkedin_router
from app.api.queue import router as queue_router
from app.api.sync import router as sync_router
from app.config import get_settings
from app.dashboard import router as dashboard_router
from app.database import SessionLocal
from app.services.sync import run_sync

BASE_DIR = Path(__file__).resolve().parent.parent

scheduler = BackgroundScheduler()

LINKEDIN_ORIGINS = frozenset({
  'https://www.linkedin.com',
  'https://www.linkedin.cn',
  'https://linkedin.com',
})


def _scheduled_sync() -> None:
  db = SessionLocal()
  try:
    run_sync(db)
  except Exception:
    db.rollback()
    raise
  finally:
    db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
  settings = get_settings()
  if settings.greenhouse_tokens_list or settings.lever_slugs_list:
    scheduler.add_job(
      _scheduled_sync,
      'interval',
      hours=settings.sync_interval_hours,
      id='ingest_sync',
      replace_existing=True,
    )
    scheduler.start()
  yield
  if scheduler.running:
    scheduler.shutdown(wait=False)


app = FastAPI(title='Job pipeline', lifespan=lifespan)


@app.middleware('http')
async def linkedin_capture_cors(request: Request, call_next):
  """Narrow CORS for bookmarklet: LinkedIn origin only on capture endpoint."""
  response = await call_next(request)
  path = request.url.path.rstrip('/')
  if path == '/api/linkedin/capture':
    origin = request.headers.get('origin')
    if origin and ('linkedin.com' in origin or origin in LINKEDIN_ORIGINS):
      response.headers['Access-Control-Allow-Origin'] = origin
      response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
      response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key, Authorization'
      response.headers['Access-Control-Max-Age'] = '86400'
  return response


@app.middleware('http')
async def auth_middleware(request: Request, call_next):
  path = request.url.path
  if path == '/health' or path.startswith('/static') or path in ('/favicon.ico',):
    return await call_next(request)
  check_api_auth(request)
  return await call_next(request)


@app.get('/health')
def health():
  return {'status': 'ok'}


app.include_router(linkedin_router)
app.include_router(companies_router)
app.include_router(jobs_router)
app.include_router(queue_router)
app.include_router(applications_router)
app.include_router(sync_router)
app.include_router(export_router)
app.include_router(dashboard_router)

app.mount('/static', StaticFiles(directory=str(BASE_DIR / 'static')), name='static')
