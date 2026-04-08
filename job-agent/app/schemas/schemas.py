from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class LinkedInCaptureIn(BaseModel):
  url: str = Field(..., max_length=4096)
  title: str | None = Field(None, max_length=1024)
  company: str | None = Field(None, max_length=512)
  snippet: str | None = Field(None, max_length=8000)


class LinkedInCaptureOut(BaseModel):
  job_posting_id: int
  match_score: int | None
  match_reasons: list[Any] | None
  external_id: str
