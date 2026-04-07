from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import Company
from app.schemas.schemas import CompanyCreate, CompanyOut

router = APIRouter(prefix='/api/companies', tags=['companies'])


@router.get('', response_model=list[CompanyOut])
def list_companies(db: Session = Depends(get_db)) -> list[Company]:
  return db.query(Company).order_by(Company.name).all()


@router.post('', response_model=CompanyOut)
def create_company(body: CompanyCreate, db: Session = Depends(get_db)) -> Company:
  c = Company(
    name=body.name,
    ats_type=body.ats_type,
    career_page_url=body.career_page_url,
    board_token=body.board_token,
    lever_slug=body.lever_slug,
  )
  db.add(c)
  db.commit()
  db.refresh(c)
  return c
