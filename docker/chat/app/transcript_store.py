"""Best-effort chat transcript persistence for admin review."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

CHAT_LIST_PK = 'CHAT_TRANSCRIPT'

# ADR-0020 A3.2. Every turn is list_append'ed into ONE DynamoDB item under a
# 400 KB hard limit. Without a bound, enough turns make the item no longer fit:
# every later write for that session raises, is swallowed in persist_turn, and
# the turn is lost -- a permanently wedged session with no visible symptom.
# The budget is carried IN the item (`bytesStored`) and the write is conditional
# on it, leaving 20 KiB of headroom for one more maximal turn plus the
# item-level scaffolding.
SESSION_BYTE_BUDGET = 380 * 1024


class TranscriptStore:
    def __init__(self, table_name: str) -> None:
        self.table_name = table_name
        self._table = None
        self._disabled = False
        # Live counters surfaced via /ready (Phase 7 — production diagnostics).
        # Lets the operator answer "is persistence actually firing?" with a
        # single GET against the chat host, instead of correlating ECS logs
        # to DynamoDB scans. Reset only on process restart.
        self.writes_attempted = 0
        self.writes_succeeded = 0
        self.writes_failed = 0
        self.last_error: str | None = None
        self.last_success_at: str | None = None
        self.last_attempt_at: str | None = None

    def stats(self) -> dict[str, Any]:
        return {
            'table_name': self.table_name,
            'disabled': self._disabled,
            'writes_attempted': self.writes_attempted,
            'writes_succeeded': self.writes_succeeded,
            'writes_failed': self.writes_failed,
            'last_error': self.last_error,
            'last_success_at': self.last_success_at,
            'last_attempt_at': self.last_attempt_at,
        }

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
            # Raise so persist_turn's exception branch fires and bumps
            # writes_failed + last_error. Used to `return` silently here,
            # which let writes_succeeded climb while boto3 was actually
            # uninstalled — invisible bug, took a manual DDB scan to spot.
            raise RuntimeError(
                'transcript_store is disabled (boto3 import failed at startup; '
                'check requirements.txt and rebuild the chat image)'
            )
        table.update_item(
            Key={'id': session_id},
            UpdateExpression=(
                'SET listPk = :listPk, '
                'createdAt = if_not_exists(createdAt, :createdAt), '
                'updatedAt = :updatedAt, '
                'promptVersion = :promptVersion, '
                'provider = :provider, '
                'model = :model, '
                'reviewed = if_not_exists(reviewed, :reviewedDefault), '
                'adminNotes = if_not_exists(adminNotes, :adminNotesDefault), '
                'turns = list_append(if_not_exists(turns, :emptyTurns), :newTurn), '
                'flags = :flags, '
                'flagged = :flagged, '
                'turnCount = if_not_exists(turnCount, :zero) + :one, '
                'bytesStored = if_not_exists(bytesStored, :zero) + :turnBytes'
            ),
            # `attribute_not_exists` is not optional: a brand-new item has no
            # bytesStored, so without it the condition is false on turn one and
            # no session could ever start. DynamoDB evaluates UpdateItem
            # atomically, so a refused write appends nothing and increments
            # nothing: the item stays valid and the session simply stops
            # accepting turns (loudly -- A3.1 alerts on the exception).
            ConditionExpression=(
                'attribute_not_exists(bytesStored) OR bytesStored < :budget'
            ),
            ExpressionAttributeValues={
                ':listPk': CHAT_LIST_PK,
                ':createdAt': created_at,
                ':updatedAt': created_at,
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
                # Charge the turn being appended, not the whole write: the
                # item-level fields are SET fresh each turn, never accumulated.
                ':turnBytes': len(json.dumps(turn).encode('utf-8')),
                ':budget': SESSION_BYTE_BUDGET,
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
        self.writes_attempted += 1
        self.last_attempt_at = datetime.now(timezone.utc).isoformat()
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
            self.writes_succeeded += 1
            self.last_success_at = datetime.now(timezone.utc).isoformat()
            self.last_error = None
        except Exception as exc:
            self.writes_failed += 1
            # Truncate so a giant DynamoDB error doesn't bloat /ready output.
            self.last_error = f'{type(exc).__name__}: {str(exc)[:240]}'
            logger.exception("Failed to persist chat transcript id=%s", resolved_id)
            from app.alerts import fire_alert

            detail = f'{type(exc).__name__}: {str(exc)[:240]} (session_id={resolved_id})'
            # Two different operational facts, so two event TYPES (ADR-0020
            # 5.13): a budget refusal means writes are healthy and ONE session
            # is full (P2); anything else means writes are broken (P1).
            # alerts.py throttles per event type, so sharing one type would let
            # the frequent benign refusal suppress a real outage for the whole
            # cooldown window. Discriminate by class NAME, not a botocore
            # import: this module must survive boto3 being absent.
            if type(exc).__name__ == 'ConditionalCheckFailedException':
                fire_alert(
                    'chat_transcript_session_full',
                    f'transcript session {resolved_id} hit its byte budget',
                    detail,
                )
            else:
                fire_alert(
                    'chat_transcript_write_failed',
                    f'transcript persist failed for session {resolved_id}',
                    detail,
                )


def build_transcript_store() -> TranscriptStore | None:
    table_name = (os.environ.get('CHAT_TRANSCRIPTS_TABLE') or '').strip()
    if not table_name:
        return None
    return TranscriptStore(table_name=table_name)
