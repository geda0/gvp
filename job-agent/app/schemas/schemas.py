from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CompanyCreate(BaseModel):
  name: str = Field(..., max_length=512)
  ats_type: str = Field(default='manual')
  career_page_url: str | None = None
  board_token: str | None = None
  lever_slug: str | None = None


class CompanyOut(BaseModel):
  model_config = ConfigDict(from_attributes=True)

  id: int
  name: str
  ats_type: str
  board_token: str | None
  lever_slug: str | None
  career_page_url: str | None
  created_at: datetime | None


class JobPostingOut(BaseModel):
  model_config = ConfigDict(from_attributes=True)

  id: int
  company_id: int
  source: str
  external_id: str
  title: str
  location: str | None
  absolute_url: str
  content_snippet: str | None
  first_seen: datetime | None
  last_seen: datetime | None
  match_score: int | None
  match_reasons: list[Any] | None
  user_dismissed: bool


class ManualJobCreate(BaseModel):
  company_name: str
  title: str
  absolute_url: str
  location: str | None = None
  content_snippet: str | None = None


class ApplicationCreate(BaseModel):
  status: str = 'interested'
  notes: str | None = None
  resume_version_id: str | None = None
  cover_letter_text: str | None = None
  answers_json: dict[str, Any] | None = None
  attachments_meta: list[Any] | None = None


class ApplicationUpdate(BaseModel):
  status: str | None = None
  submitted_at: datetime | None = None
  notes: str | None = None
  resume_version_id: str | None = None
  cover_letter_text: str | None = None
  answers_json: dict[str, Any] | None = None
  attachments_meta: list[Any] | None = None


class ApplicationEventCreate(BaseModel):
  event_type: str
  payload: dict[str, Any] | None = None


class ApplicationEventOut(BaseModel):
  model_config = ConfigDict(from_attributes=True)

  id: int
  application_id: int
  event_type: str
  payload: dict[str, Any] | None
  created_at: datetime | None


class ApplicationOut(BaseModel):
  model_config = ConfigDict(from_attributes=True)

  id: int
  job_posting_id: int
  status: str
  submitted_at: datetime | None
  notes: str | None
  resume_version_id: str | None
  cover_letter_text: str | None
  answers_json: dict[str, Any] | None
  attachments_meta: list[Any] | None
  created_at: datetime | None
  updated_at: datetime | None


class ApplicationDetailOut(ApplicationOut):
  job_posting: JobPostingOut
  events: list[ApplicationEventOut] = []
