from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import Company

router = APIRouter(prefix='/api/companies', tags=['companies'])


@router.get('')
def list_companies(db: Session = Depends(get_db)):
  return db.query(Company).order_by(Company.name).all()
