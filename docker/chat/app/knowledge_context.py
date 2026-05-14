"""Knowledge pack loading and deterministic per-turn retrieval."""

from __future__ import annotations

import html
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage

logger = logging.getLogger(__name__)

DEFAULT_HISTORY_TAIL = 12
DEFAULT_MAX_ROLE_MATCHES = 4
DEFAULT_MAX_PROJECT_MATCHES = 3

SYNONYMS: dict[str, set[str]] = {
    'aws': {
        'aws',
        'amazon web services',
        'api gateway',
        'lambda',
        'dynamo',
        'dynamodb',
        'sqs',
        'sam',
        'serverless',
    },
    'platform architecture': {'platform architecture', 'service boundaries', 'system design'},
    'subscriptions': {'subscription', 'subscriptions', 'billing', 'entitlement'},
    'identity': {'identity', 'auth', 'authentication', 'directory', 'iam'},
    'data pipelines': {'data pipeline', 'data pipelines', 'ingestion', 'etl', 'reporting'},
    'saas': {'saas', 'software as a service'},
    'frontend': {'frontend', 'front end', 'ui', 'ux'},
    'python': {'python'},
    'java': {'java', 'jvm'},
    'node.js': {'node', 'nodejs', 'node.js'},
    'typescript': {'typescript', 'ts'},
    'operations': {'on-call', 'on call', 'observability', 'alerts', 'runbooks', 'operability'},
}


def _content_root() -> Path:
    """Repo root (dev) or image app root (Docker).

    In the monorepo, this file lives at ``<root>/docker/chat/app/``.
    In the compose image it lives at ``/app/app/`` with corpus files under
    ``/app/``. Walking upward avoids brittle ``parents[N]`` indexing.
    """
    here = Path(__file__).resolve().parent
    cur: Path | None = here
    for _ in range(32):
        if cur is None:
            break
        try:
            if (cur / 'data' / 'chat-knowledge').is_dir():
                return cur
        except OSError:
            pass
        try:
            if (cur / 'docker' / 'chat' / 'prompts' / 'system-prompt.md').is_file():
                return cur
        except OSError:
            pass
        try:
            if (cur / 'prompts' / 'system-prompt.md').is_file():
                return cur
        except OSError:
            pass
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return here.parent


def default_pack_dir() -> Path:
    env_path = os.environ.get('CHAT_KNOWLEDGE_DIR', '').strip()
    if env_path:
        return Path(env_path)
    return _content_root() / 'data' / 'chat-knowledge'


def default_system_prompt_path() -> Path:
    env_path = os.environ.get('CHAT_SYSTEM_PROMPT_PATH', '').strip()
    if env_path:
        return Path(env_path)
    root = _content_root()
    mono = root / 'docker' / 'chat' / 'prompts' / 'system-prompt.md'
    if mono.is_file():
        return mono
    flat = root / 'prompts' / 'system-prompt.md'
    if flat.is_file():
        return flat
    return mono


def normalize(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '').strip().lower())


def _tokens(text: str) -> set[str]:
    return set(re.findall(r'[a-z0-9]+', normalize(text)))


def load_json_file(path: Path, fallback: Any) -> Any:
    if not path.is_file():
        logger.warning('Knowledge file missing: %s', path)
        return fallback
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning('Failed to read %s: %s', path, exc)
        return fallback


def load_knowledge_pack(pack_dir: Path) -> dict[str, Any]:
    return {
        'bio': load_json_file(pack_dir / 'bio.json', {}),
        'roles': load_json_file(pack_dir / 'roles.json', []),
        'projects': load_json_file(pack_dir / 'projects.json', []),
        'faq': load_json_file(pack_dir / 'faq.json', []),
    }


def parse_prompt_version(text: str) -> str:
    match = re.search(r'prompt-version:\s*([a-zA-Z0-9.\-_]+)', text or '')
    return match.group(1) if match else 'unknown'


def load_system_prompt(path: Path) -> tuple[str, str]:
    if not path.is_file():
        raise RuntimeError(f'System prompt file missing: {path}')
    text = path.read_text(encoding='utf-8').strip()
    if not text:
        raise RuntimeError(f'System prompt file is empty: {path}')
    return text, parse_prompt_version(text)


def summarize_pruned_messages(messages: list[Any], max_topics: int = 4) -> str:
    topics: list[str] = []
    for msg in messages:
        if getattr(msg, 'type', None) != 'human':
            continue
        content = normalize(getattr(msg, 'content', ''))
        if not content:
            continue
        line = content.split('\n', 1)[0][:120]
        if line and line not in topics:
            topics.append(line)
        if len(topics) >= max_topics:
            break
    if not topics:
        return ''
    return f"Earlier in this conversation, the visitor asked about: {', '.join(topics)}."


def compact_history(messages: list[Any], max_messages: int = DEFAULT_HISTORY_TAIL) -> list[Any]:
    if len(messages) <= max_messages:
        return messages
    pruned = messages[:-max_messages]
    kept = messages[-max_messages:]
    summary = summarize_pruned_messages(pruned)
    if summary:
        return [HumanMessage(content=summary), *kept]
    return kept


def extract_tags(text: str) -> set[str]:
    normalized = normalize(text)
    found: set[str] = set()
    for tag, variants in SYNONYMS.items():
        if any(v in normalized for v in variants):
            found.add(tag)
    return found


def match_faq(user_message: str, faq_rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    message_norm = normalize(user_message)
    message_tokens = _tokens(message_norm)
    best: tuple[float, dict[str, Any] | None] = (0.0, None)

    for row in faq_rows or []:
        for question in row.get('q') or []:
            q_norm = normalize(str(question))
            if not q_norm:
                continue
            if q_norm in message_norm:
                score = len(q_norm) + 1000
            else:
                q_tokens = _tokens(q_norm)
                if not q_tokens:
                    continue
                overlap = len(q_tokens & message_tokens) / len(q_tokens)
                score = overlap
            if score > best[0]:
                best = (score, row)

    if best[0] >= 0.6:
        return best[1]
    return None


def _is_relevant(item: dict[str, Any], tags: set[str]) -> bool:
    item_tags = {normalize(t) for t in item.get('relevance_tags') or []}
    return bool(item_tags & tags)


def build_context(
    user_message: str,
    history_text: str,
    pack: dict[str, Any],
    max_roles: int = DEFAULT_MAX_ROLE_MATCHES,
    max_projects: int = DEFAULT_MAX_PROJECT_MATCHES,
) -> dict[str, Any]:
    tags = extract_tags(f'{user_message} {history_text}')
    faq_match = match_faq(user_message, pack.get('faq') or [])

    roles_all = list(pack.get('roles') or [])
    projects_all = list(pack.get('projects') or [])

    roles = [r for r in roles_all if _is_relevant(r, tags)][:max_roles]
    projects = [p for p in projects_all if _is_relevant(p, tags)][:max_projects]

    if not roles:
        roles = roles_all[:2]
    if not projects:
        projects = projects_all[:2]

    return {
        'bio': pack.get('bio') or {},
        'roles': roles,
        'projects': projects,
        'faq_match': faq_match,
        'tags': sorted(tags),
    }


def _xml_safe(value: Any) -> str:
    return html.escape(str(value or ''), quote=True)


def serialize_context_xml(context: dict[str, Any]) -> str:
    bio = context.get('bio') or {}
    roles = context.get('roles') or []
    projects = context.get('projects') or []
    faq_match = context.get('faq_match')
    tags = context.get('tags') or []

    parts: list[str] = ['<knowledge_pack>']
    parts.append('<bio>')
    parts.append(_xml_safe(json.dumps(bio, ensure_ascii=False)))
    parts.append('</bio>')
    parts.append('<retrieval_tags>')
    parts.append(_xml_safe(', '.join(tags)))
    parts.append('</retrieval_tags>')
    parts.append('<relevant_roles>')
    for role in roles:
        rid = _xml_safe(role.get('id', 'unknown'))
        parts.append(f'<role id="{rid}">{_xml_safe(json.dumps(role, ensure_ascii=False))}</role>')
    parts.append('</relevant_roles>')
    parts.append('<relevant_projects>')
    for project in projects:
        pid = _xml_safe(project.get('id', 'unknown'))
        parts.append(
            f'<project id="{pid}">{_xml_safe(json.dumps(project, ensure_ascii=False))}</project>'
        )
    parts.append('</relevant_projects>')

    if faq_match:
        answer = _xml_safe(faq_match.get('a', ''))
        trigger_tool = faq_match.get('trigger_tool')
        parts.append('<suggested_response>')
        parts.append(
            "The visitor's question closely matches a FAQ entry. Use this as the basis "
            f'for your answer, paraphrasing for fit: "{answer}".'
        )
        if trigger_tool:
            parts.append(f' After answering, call the tool: {_xml_safe(trigger_tool)}.')
        parts.append('</suggested_response>')
    parts.append('</knowledge_pack>')
    return ''.join(parts)
