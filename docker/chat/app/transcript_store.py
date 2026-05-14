"""Best-effort chat transcript persistence for admin review."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

CHAT_LIST_PK = 'CHAT_TRANSCRIPT'


class TranscriptStore:
    def __init__(self, table_name: str, ttl_days: int = 30) -> None:
        self.table_name = table_name
        self.ttl_days = max(1, ttl_days)
        self._table = None
        self._disabled = False

    def _get_table(self):
        if self._disabled:
            return None
        if self._table is not None:
            return self._table
        try:
            import boto3  # type: ignore[import-not-found]
        except Exception:
            logger.warning("boto3 unavailable; transcript persistence disabled")
            self._disabled = True
            return None
        self._table = boto3.resource('dynamodb').Table(self.table_name)
        return self._table

    def _persist_sync(
        self,
        session_id: str,
        created_at: str,
        prompt_version: str,
        provider: str,
        model: str,
        turn: dict[str, Any],
        flags: dict[str, bool],
    ) -> None:
        table = self._get_table()
        if table is None:
            return
        expires_at = int(
            (datetime.now(timezone.utc) + timedelta(days=self.ttl_days)).timestamp()
        )
        table.update_item(
            Key={'id': session_id},
            UpdateExpression=(
                'SET listPk = :listPk, '
                'createdAt = if_not_exists(createdAt, :createdAt), '
                'updatedAt = :updatedAt, '
                'expiresAt = :expiresAt, '
                'promptVersion = :promptVersion, '
                'provider = :provider, '
                'model = :model, '
                'reviewed = if_not_exists(reviewed, :reviewedDefault), '
                'adminNotes = if_not_exists(adminNotes, :adminNotesDefault), '
                'turns = list_append(if_not_exists(turns, :emptyTurns), :newTurn), '
                'flags = :flags, '
                'flagged = :flagged, '
                'turnCount = if_not_exists(turnCount, :zero) + :one'
            ),
            ExpressionAttributeValues={
                ':listPk': CHAT_LIST_PK,
                ':createdAt': created_at,
                ':updatedAt': created_at,
                ':expiresAt': expires_at,
                ':promptVersion': prompt_version,
                ':provider': provider,
                ':model': model,
                ':reviewedDefault': False,
                ':adminNotesDefault': '',
                ':emptyTurns': [],
                ':newTurn': [turn],
                ':flags': flags,
                ':flagged': any(bool(v) for v in flags.values()),
                ':zero': 0,
                ':one': 1,
            },
        )

    async def persist_turn(
        self,
        session_id: str | None,
        created_at: str,
        prompt_version: str,
        provider: str,
        model: str,
        turn: dict[str, Any],
        flags: dict[str, bool],
    ) -> None:
        resolved_id = str(session_id or '').strip() or f"chat-{uuid4()}"
        try:
            await asyncio.to_thread(
                self._persist_sync,
                resolved_id,
                created_at,
                prompt_version,
                provider,
                model,
                turn,
                flags,
            )
        except Exception:
            logger.exception("Failed to persist chat transcript id=%s", resolved_id)


def build_transcript_store() -> TranscriptStore | None:
    table_name = (os.environ.get('CHAT_TRANSCRIPTS_TABLE') or '').strip()
    if not table_name:
        return None
    ttl_days_raw = (os.environ.get('CHAT_TRANSCRIPT_TTL_DAYS') or '30').strip()
    try:
        ttl_days = int(ttl_days_raw)
    except ValueError:
        ttl_days = 30
    return TranscriptStore(table_name=table_name, ttl_days=ttl_days)
