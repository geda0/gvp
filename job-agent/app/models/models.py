import enum
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


class ApplicationStatus(str, enum.Enum):
  interested = 'interested'
  preparing = 'preparing'
  submitted = 'submitted'
  interviewing = 'interviewing'
  offer = 'offer'
  rejected = 'rejected'
  withdrawn = 'withdrawn'


class Company(Base):
  __tablename__ = 'companies'

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  name: Mapped[str] = mapped_column(String(512), nullable=False)
  ats_type: Mapped[str] = mapped_column(String(32), default='unknown')
  board_token: Mapped[str | None] = mapped_column(String(256), nullable=True)
  lever_slug: Mapped[str | None] = mapped_column(String(256), nullable=True)
  career_page_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

  job_postings: Mapped[list['JobPosting']] = relationship(back_populates='company')


class JobPosting(Base):
  __tablename__ = 'job_postings'
  __table_args__ = (UniqueConstraint('source', 'external_id', name='uq_job_source_external'),)

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  company_id: Mapped[int] = mapped_column(ForeignKey('companies.id'), nullable=False)
  source: Mapped[str] = mapped_column(String(64), nullable=False)
  external_id: Mapped[str] = mapped_column(String(256), nullable=False)
  title: Mapped[str] = mapped_column(String(1024), nullable=False)
  location: Mapped[str | None] = mapped_column(String(512), nullable=True)
  absolute_url: Mapped[str] = mapped_column(String(4096), nullable=False)
  content_snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
  raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
  first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
  last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
  match_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
  match_reasons: Mapped[list | None] = mapped_column(JSON, nullable=True)
  user_dismissed: Mapped[bool] = mapped_column(Boolean, default=False)

  company: Mapped['Company'] = relationship(back_populates='job_postings')
  application: Mapped['Application | None'] = relationship(back_populates='job_posting', uselist=False)


class Application(Base):
  __tablename__ = 'applications'

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  job_posting_id: Mapped[int] = mapped_column(ForeignKey('job_postings.id'), nullable=False, unique=True)
  status: Mapped[str] = mapped_column(String(32), default=ApplicationStatus.interested.value)
  submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
  notes: Mapped[str | None] = mapped_column(Text, nullable=True)
  resume_version_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
  cover_letter_text: Mapped[str | None] = mapped_column(Text, nullable=True)
  answers_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
  attachments_meta: Mapped[list | None] = mapped_column(JSON, nullable=True)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

  job_posting: Mapped['JobPosting'] = relationship(back_populates='application')
  events: Mapped[list['ApplicationEvent']] = relationship(
    back_populates='application',
    order_by='ApplicationEvent.created_at',
  )


class ApplyProfile(Base):
  __tablename__ = 'apply_profile'

  id: Mapped[int] = mapped_column(Integer, primary_key=True)
  full_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
  email: Mapped[str | None] = mapped_column(String(512), nullable=True)
  phone: Mapped[str | None] = mapped_column(String(128), nullable=True)
  linkedin_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
  work_authorization: Mapped[str | None] = mapped_column(String(512), nullable=True)
  cover_letter_template: Mapped[str | None] = mapped_column(Text, nullable=True)
  answers_defaults_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
  learned_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
  updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ApplicationEvent(Base):
  __tablename__ = 'application_events'

  id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
  application_id: Mapped[int] = mapped_column(ForeignKey('applications.id'), nullable=False)
  event_type: Mapped[str] = mapped_column(String(64), nullable=False)
  payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

  application: Mapped['Application'] = relationship(back_populates='events')
