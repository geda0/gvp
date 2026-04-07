from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.services.sync import run_sync

router = APIRouter(prefix='/api/sync', tags=['sync'])


@router.post('/run')
def sync_now(db: Session = Depends(get_db)) -> dict:
  stats = run_sync(db)
  return {'ok': True, 'stats': stats}
