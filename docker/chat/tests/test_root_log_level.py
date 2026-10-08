"""ADR-0022 §31.4 — importing the app must leave INFO actually reaching a root
handler that already existed.

WHY THIS IS NOT "assert the root logger's level is INFO". That assertion passes for
`basicConfig(level=logging.INFO, force=True)`, which §31.2 REFUSES: force=True
removes the pre-existing handler and installs a fresh one with Python's default
format, so the record is delivered somewhere else and the managed runtime's
`[LEVEL]\tts\tRequestId\t` framing is lost — the framing §25.3-M read request-id
correlation off. Asserting the level discriminates the defect from a fix; it does not
discriminate the RIGHT fix from the wrong one. So this asserts that the record
ARRIVES, framed, at the handler that was already there.

MEASURED DEFECT this pins (2026-10-08): `logging.basicConfig(level=logging.INFO)`
configures the root logger only when the root has NO handlers. The managed Lambda
runtime installs one before the app imports, so the call returned early and set
nothing — not even the level. Over 24h the Mangum/HttpApi host emitted 0 INFO lines
against 2 WARNING and 2 ERROR, while the uvicorn/stream host emitted 125 INFO.

SUBPROCESS, for two concrete reasons rather than tidiness:
  1. `app.main` is already imported by the time any test body runs, and
     `importlib.reload` would rebind `app` to a new FastAPI object while other tests
     hold `from app.main import app`.
  2. pytest's logging plugin attaches its own handler to the root logger, which
     confounds both the precondition (a root that has exactly our handler) and the
     assertion (what reached it).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

CHAT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = CHAT_DIR.parent.parent

# Runs in a clean interpreter. Prints one line per assertion so a failure says which.
PROBE = r'''
import io, logging, sys

root = logging.getLogger()
for h in list(root.handlers):
    root.removeHandler(h)

# Stand in for the managed runtime's handler: it OWNS the line framing, and it is
# installed BEFORE the app imports. That ordering is the whole precondition.
buf = io.StringIO()
runtime_handler = logging.StreamHandler(buf)
runtime_handler.setFormatter(logging.Formatter('[%(levelname)s]\tRID\t%(message)s'))
root.addHandler(runtime_handler)
root.setLevel(logging.WARNING)

# A3 — control. Before the import, an INFO record must be dropped. Without this the
# other two could pass on an interpreter that was never in the broken state.
logging.getLogger('app.probe').info('before import')
print('A3_BEFORE_IMPORT', repr(buf.getvalue()))

import app.main  # noqa: F401  -- the import under test

logging.getLogger('app.probe').info('probe line')
print('A1_AFTER_IMPORT', repr(buf.getvalue()))
print('A2_HANDLER_IDENTITY', runtime_handler in logging.getLogger().handlers)
'''


def _run_probe() -> dict[str, str]:
    env = dict(os.environ)
    # Mirror conftest, or the import fails for an unrelated reason and the test
    # would go red without telling us anything about logging.
    env['CHAT_PROVIDER'] = 'mock'
    env.setdefault('CHAT_KNOWLEDGE_DIR', str(REPO_ROOT / 'data' / 'chat-knowledge'))
    env.setdefault(
        'CHAT_SYSTEM_PROMPT_PATH',
        str(CHAT_DIR / 'prompts' / 'system-prompt.md'),
    )
    env['PYTHONPATH'] = str(CHAT_DIR)
    proc = subprocess.run(
        [sys.executable, '-c', PROBE],
        capture_output=True, text=True, cwd=str(CHAT_DIR), env=env, timeout=120,
    )
    assert proc.returncode == 0, (
        'the probe interpreter failed before it could assert anything '
        f'(this is NOT the behaviour under test):\n{proc.stderr[-2000:]}'
    )
    out = {}
    for line in proc.stdout.splitlines():
        if ' ' in line:
            key, _, value = line.partition(' ')
            out[key] = value
    return out


def test_importing_the_app_makes_info_reach_a_preexisting_root_handler() -> None:
    result = _run_probe()

    # A3 first: the interpreter really was in the broken state to begin with.
    assert result.get('A3_BEFORE_IMPORT') == "''", (
        'control failed: an INFO record was already reaching the handler BEFORE the '
        'import, so this probe never reproduced the condition the fix addresses '
        f'(got {result.get("A3_BEFORE_IMPORT")!r})'
    )

    # A1 — the load-bearing one. The record must ARRIVE, and arrive FRAMED by the
    # handler that already existed.
    assert result.get('A1_AFTER_IMPORT') == repr('[INFO]\tRID\tprobe line\n'), (
        'importing app.main left INFO records from a pre-existing root handler '
        'either dropped (basicConfig is a no-op when a handler is already present, '
        'so it sets nothing — not even the level) or delivered elsewhere with '
        "different framing (basicConfig(force=True) replaces the handler). Got "
        f'{result.get("A1_AFTER_IMPORT")!r}'
    )

    # A2 — pins the ruling, by IDENTITY not count: a replacement handler would also
    # make the count 1. Catches a later "simplification" to force=True.
    assert result.get('A2_HANDLER_IDENTITY') == 'True', (
        'the root handler that existed before the import is no longer attached, so '
        'the app replaced it (ADR-0022 §31.2 refuses force=True for exactly this: '
        'it discards the runtime handler and with it the RequestId framing that '
        '§25.3-M read its timing from)'
    )
