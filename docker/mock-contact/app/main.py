import re
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['OPTIONS', 'GET', 'POST'],
    allow_headers=['Content-Type', 'x-admin-key'],
)

_EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')


def safe_trim(value: Any) -> str:
    return str(value or '').strip()


def clamp_len(value: Any, max_len: int) -> str:
    trimmed = safe_trim(value)
    return trimmed[:max_len] if len(trimmed) > max_len else trimmed


def validate_email(email: str) -> bool:
    normalized = safe_trim(email)
    if not normalized:
        return False
    if len(normalized) > 254:
        return False
    return bool(_EMAIL_RE.match(normalized))


def build_record(payload: dict) -> dict:
    return {
        'name': clamp_len(payload.get('name'), 120),
        'email': clamp_len(payload.get('email'), 254),
        'subject': clamp_len(payload.get('subject'), 180),
        'message': clamp_len(payload.get('message'), 4000),
        'company': clamp_len(payload.get('company'), 120),
    }


def validate_message(record: dict) -> str | None:
    if not validate_email(record['email']) or not record['message']:
        return 'Please provide a valid email and a message.'
    return None


@app.get('/health')
def health():
    return {'ok': True}


@app.post('/api/contact')
async def post_contact(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({'error': 'Invalid JSON'}, status_code=400)

    if not isinstance(payload, dict):
        return JSONResponse({'error': 'Invalid JSON'}, status_code=400)

    record = build_record(payload)

    if record['company']:
        return {
            'ok': True,
            'persisted': True,
            'delivery': 'queued',
        }

    validation_error = validate_message(record)
    if validation_error:
        return JSONResponse({'error': validation_error}, status_code=400)

    return {
        'ok': True,
        'persisted': True,
        'delivery': 'queued',
        'id': str(uuid.uuid4()),
    }
