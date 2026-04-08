import json
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
  model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

  database_url: str = 'sqlite:///./jobagent.db'
  api_key: str | None = None
  public_base_url: str = 'http://127.0.0.1:8080'
  sync_interval_hours: float = 6.0
  match_score_threshold: int = 25
  greenhouse_board_tokens: str = '[]'
  lever_account_slugs: str = '[]'
  profile_json_path: str | None = None

  @property
  def greenhouse_tokens_list(self) -> list[str]:
    return _parse_json_list(self.greenhouse_board_tokens)

  @property
  def lever_slugs_list(self) -> list[str]:
    return _parse_json_list(self.lever_account_slugs)


def _parse_json_list(raw: str) -> list[str]:
  if not raw or raw.strip() == '':
    return []
  try:
    data = json.loads(raw)
    if isinstance(data, list):
      return [str(x) for x in data]
  except json.JSONDecodeError:
    pass
  return []


@lru_cache
def get_settings() -> Settings:
  return Settings()
