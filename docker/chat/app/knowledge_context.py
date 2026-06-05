"""Knowledge pack loading and deterministic per-turn retrieval."""

from __future__ import annotations

import html
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from app.messages import Msg

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
    'spark': {'spark', 'emr', 'apache spark', 'scala spark', 'databricks'},
    'graphql': {'graphql', 'graph ql', 'apollo'},
    'kubernetes': {'kubernetes', 'k8s', 'kube'},
    'mongodb': {'mongodb', 'mongo db', 'mongo'},
    'microservices': {'microservices', 'microservice', 'service oriented', 'soa'},
    'mentoring': {'mentoring', 'mentor', 'leadership', 'led teams', 'team lead'},
    # AI / this-site retrieval — lets visitors asking "how does this chat work"
    # or "tell me about the assistant" pull the chatbot project entry up.
    'ai': {'ai', 'gen ai', 'genai', 'llm', 'llms', 'gemini', 'chatbot', 'agent', 'assistant', 'gpt', 'claude'},
    'this-site': {'this site', 'this chat', 'this chatbot', 'this assistant', 'this agent', 'this bot', 'the chat agent'},
    # Category tags used as relevance_tags in the data — make them reachable from natural
    # queries so "side projects" / "his experience" surface the items tagged with them.
    'playground': {'playground', 'side project', 'side projects', 'experiment', 'experiments', 'hobby project', 'personal build', 'personal builds', 'labs'},
    'portfolio': {'portfolio', 'work history', 'past roles', 'career', 'resume', 'cv', 'work experience', 'professional experience'},
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
    lines = [line.strip() for line in (text or '').splitlines() if line.strip()]
    if not lines:
        return 'unknown'
    first = lines[0]
    match = re.match(
        r'(?:<!--\s*)?prompt-version:\s*([a-zA-Z0-9.\-_]+)(?:\s*-->)?$',
        first,
        flags=re.IGNORECASE,
    )
    return match.group(1) if match else 'unknown'


def load_system_prompt(path: Path) -> tuple[str, str]:
    if not path.is_file():
        raise RuntimeError(f'System prompt file missing: {path}')
    text = path.read_text(encoding='utf-8').strip()
    if not text:
        raise RuntimeError(f'System prompt file is empty: {path}')
    version = parse_prompt_version(text)
    if version == 'unknown':
        raise RuntimeError(
            'System prompt is missing a parseable first-line prompt-version header'
        )
    return text, version


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
        return [Msg(role="human", content=summary), *kept]
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


def _mentions_item(item: dict[str, Any], query_norm: str) -> bool:
    """True when the query names this item directly (its name / company / id).

    Uses whole-string substring matching with a 3-char floor, so a query like
    "what did he do at Apptio" retrieves the Apptio entry deterministically rather
    than relying on it sitting in the first two array slots — while short, generic
    tokens (a 2-char company, "at", "of") never false-match.
    """
    if not query_norm:
        return False
    for key in ('name', 'company'):
        val = normalize(item.get(key) or '')
        if len(val) >= 3 and val in query_norm:
            return True
    item_id = normalize(str(item.get('id') or '').replace('-', ' ').replace('_', ' '))
    return len(item_id) >= 3 and item_id in query_norm


def _is_relevant(item: dict[str, Any], tags: set[str], query_norm: str = '') -> bool:
    item_tags = {normalize(t) for t in item.get('relevance_tags') or []}
    if item_tags & tags:
        return True
    return _mentions_item(item, query_norm)


def _index_entry(item: dict[str, Any], label_key: str) -> dict[str, Any]:
    """Lightweight roster entry (id + display name + one-liner) for the always-present
    index, so the assistant can enumerate every project/role even when only a few are
    retrieved in detail."""
    one = item.get('why_it_matters') or item.get('summary') or item.get('product') or ''
    name = item.get(label_key) or item.get('name') or item.get('company') or item.get('id') or ''
    return {
        'id': item.get('id'),
        'name': str(name),
        'one_liner': _truncate_text(str(one), 100),
    }


def build_context(
    user_message: str,
    history_text: str,
    pack: dict[str, Any],
    max_roles: int = DEFAULT_MAX_ROLE_MATCHES,
    max_projects: int = DEFAULT_MAX_PROJECT_MATCHES,
) -> dict[str, Any]:
    query = f'{user_message} {history_text}'
    tags = extract_tags(query)
    query_norm = normalize(query)
    faq_match = match_faq(user_message, pack.get('faq') or [])

    roles_all = list(pack.get('roles') or [])
    projects_all = list(pack.get('projects') or [])

    matched_roles = [r for r in roles_all if _is_relevant(r, tags, query_norm)][:max_roles]
    matched_projects = [p for p in projects_all if _is_relevant(p, tags, query_norm)][:max_projects]
    role_fallback = len(matched_roles) == 0
    project_fallback = len(matched_projects) == 0
    roles = matched_roles if not role_fallback else roles_all[:2]
    projects = matched_projects if not project_fallback else projects_all[:2]
    # True when tag-based retrieval yielded no role/project hits and defaults were used.
    retrieval_fallback = role_fallback or project_fallback

    return {
        'bio': pack.get('bio') or {},
        'roles': roles,
        'projects': projects,
        # Always-present lightweight roster of EVERY project/role so the assistant can
        # name them all on a "list everything" query without bloating the detailed blocks.
        'project_index': [_index_entry(p, 'name') for p in projects_all],
        'role_index': [_index_entry(r, 'company') for r in roles_all],
        'faq_match': faq_match,
        'tags': sorted(tags),
        'retrieval_fallback': retrieval_fallback,
    }


def _xml_safe(value: Any) -> str:
    return html.escape(str(value or ''), quote=True)


def _truncate_text(text: str, max_len: int) -> str:
    s = str(text or '')
    if len(s) <= max_len:
        return s
    return f'{s[: max_len - 24].rstrip()}…[truncated]'


def _compact_bio(bio: dict[str, Any]) -> dict[str, Any]:
    strengths = bio.get('strengths') or []
    if isinstance(strengths, list):
        strengths_out = [_truncate_text(str(x), 120) for x in strengths[:8]]
    else:
        strengths_out = []
    tech = bio.get('tech_at_glance') or bio.get('tech') or []
    if isinstance(tech, list):
        tech_out = [str(x) for x in tech[:16]]
    else:
        tech_out = []
    speaking = bio.get('speaking_points') or []
    if isinstance(speaking, list):
        speaking_out = [_truncate_text(str(x), 280) for x in speaking[:8]]
    else:
        speaking_out = []
    services = bio.get('services') or []
    if isinstance(services, list):
        services_out = [_truncate_text(str(x), 240) for x in services[:10]]
    else:
        services_out = []
    targets = bio.get('engagement_targets') or []
    if isinstance(targets, list):
        targets_out = [_truncate_text(str(x), 200) for x in targets[:6]]
    else:
        targets_out = []
    out: dict[str, Any] = {
        'name': bio.get('name'),
        'current_status': _truncate_text(str(bio.get('current_status', '')), 240),
        'based': bio.get('based'),
        'summary': _truncate_text(str(bio.get('summary', '')), 900),
        'strengths': strengths_out,
        'tech_at_glance': tech_out,
        'contact_preference': _truncate_text(str(bio.get('contact_preference', '')), 200),
    }
    if services_out:
        out['services'] = services_out
    if targets_out:
        out['engagement_targets'] = targets_out
    if speaking_out:
        out['speaking_points'] = speaking_out
    return out


def _compact_role(role: dict[str, Any]) -> dict[str, Any]:
    highlights = role.get('highlights') or []
    if isinstance(highlights, list):
        hl = [_truncate_text(str(h), 220) for h in highlights[:6]]
    else:
        hl = []
    tech = role.get('tech') or []
    if isinstance(tech, list):
        tech_s = [str(t) for t in tech[:12]]
    else:
        tech_s = []
    return {
        'id': role.get('id'),
        'company': role.get('company'),
        'product': _truncate_text(str(role.get('product', '')), 160),
        'tenure': role.get('tenure'),
        'summary': _truncate_text(str(role.get('summary', '')), 400),
        'highlights': hl,
        'tech': tech_s,
        'relevance_tags': role.get('relevance_tags') or [],
    }


def _compact_project(project: dict[str, Any]) -> dict[str, Any]:
    tech = project.get('tech') or []
    if isinstance(tech, list):
        tech_s = [str(t) for t in tech[:14]]
    else:
        tech_s = []
    links = project.get('links') or []
    if isinstance(links, list):
        links_out = links[:3]
    else:
        links_out = []
    return {
        'id': project.get('id'),
        'name': _truncate_text(str(project.get('name', '')), 120),
        'summary': _truncate_text(str(project.get('summary', '')), 900),
        'why_it_matters': _truncate_text(str(project.get('why_it_matters', '')), 400),
        'tech': tech_s,
        'links': links_out,
        'relevance_tags': project.get('relevance_tags') or [],
    }


def build_live_system_instruction(system_prompt: str, pack: dict[str, Any]) -> str:
    """Compact portfolio grounding + voice instructions for Gemini Live setup.

    ``system_prompt`` uses the same markdown shape as text chat (including a
    ``prompt-version`` first line): either the main ``CHAT_SYSTEM_PROMPT_PATH``
    file body or optional ``CHAT_VOICE_SYSTEM_PROMPT_PATH`` loaded at app startup.

    Optional ``CHAT_VOICE_SYSTEM_APPEND`` appends a short block after the
    portfolio XML (truncated in code); use for small posture tweaks without a
    dedicated voice prompt file.
    """
    lines = [ln for ln in (system_prompt or '').splitlines() if ln.strip()]
    body_lines = lines[1:] if len(lines) > 1 else lines
    prompt_body = '\n'.join(body_lines).strip() or str(system_prompt or '').strip()
    prompt_body = _truncate_text(prompt_body, 7200)

    ctx = build_context('', '', pack)
    blob = serialize_context_xml(ctx)
    try:
        max_total = int((os.environ.get('CHAT_LIVE_SYSTEM_MAX_CHARS') or '14000').strip())
    except ValueError:
        max_total = 14000
    max_total = max(6000, min(max_total, 32000))
    budget_pack = max(3500, max_total - len(prompt_body) - 900)
    if len(blob) > budget_pack:
        blob = _truncate_text(blob, budget_pack)

    voice_rules = (
        'Voice mode: speak with a deep, calm, measured cadence — slower than '
        'conversational default. Land each phrase deliberately, and pause '
        'briefly between sentences; the lower-register pacing suits the '
        'prebuilt voice preset configured for this session. '
        'Answer concisely for speech. Always speak about Marwan in the third '
        'person — his past work, biography, services, and new engagements alike '
        '("he built", "he led", "he offers", "he can scope it with you"). He is an '
        'individual, not a team, so never use the first-person plural. Stay grounded in the '
        'portfolio XML below — never invent employers, dates, titles, or projects. '
        'Outside of Marwan-specific claims you can talk '
        'freely about technology, science, day-to-day topics, and small talk; '
        'be a good conversational partner. Reply in the visitor\'s language and '
        'switch languages with them (Arabic, Spanish, French, etc.). Keep '
        'spoken answers short by default — a sentence or two unless asked for '
        'depth.\n\n'
    )
    combined = f'{voice_rules}{prompt_body}\n\n--- Portfolio context (XML) ---\n{blob}'
    append = (os.environ.get('CHAT_VOICE_SYSTEM_APPEND') or '').strip()
    if append:
        combined = f'{combined}\n\n{_truncate_text(append, 1200)}'
    if len(combined) > max_total:
        combined = _truncate_text(combined, max_total)
    return combined


def serialize_context_xml(context: dict[str, Any]) -> str:
    bio = _compact_bio(context.get('bio') or {})
    roles = [_compact_role(r) for r in (context.get('roles') or [])]
    projects = [_compact_project(p) for p in (context.get('projects') or [])]
    faq_match = context.get('faq_match')
    tags = context.get('tags') or []

    # head: always-present grounding (bio + retrieval tags).
    head: list[str] = [
        '<knowledge_pack>',
        '<bio>', _xml_safe(json.dumps(bio, ensure_ascii=False)), '</bio>',
        '<retrieval_tags>', _xml_safe(', '.join(tags)), '</retrieval_tags>',
    ]

    # index: lightweight roster of every project/role — the enumeration aid. Dropped FIRST
    # under budget pressure (a "list all" query matches few items in detail, so it stays small
    # with the index intact; a tag-dense specific query is large and doesn't need the roster).
    index: list[str] = []
    role_index = context.get('role_index') or []
    if role_index:
        index.append('<role_index>')  # every role — answers "list his roles / experience"
        for r in role_index:
            rid = _xml_safe(r.get('id', ''))
            index.append(f'<r id="{rid}">{_xml_safe(r.get("name", ""))} — {_xml_safe(r.get("one_liner", ""))}</r>')
        index.append('</role_index>')
    project_index = context.get('project_index') or []
    if project_index:
        index.append('<project_index>')  # every project — answers "list all his builds / projects"
        for p in project_index:
            pid = _xml_safe(p.get('id', ''))
            index.append(f'<p id="{pid}">{_xml_safe(p.get("name", ""))} — {_xml_safe(p.get("one_liner", ""))}</p>')
        index.append('</project_index>')

    # body: the detailed retrieved roles/projects + FAQ suggestion + closing tag.
    body: list[str] = ['<relevant_roles>']
    for role in roles:
        rid = _xml_safe(role.get('id', 'unknown'))
        body.append(f'<role id="{rid}">{_xml_safe(json.dumps(role, ensure_ascii=False))}</role>')
    body.append('</relevant_roles>')
    body.append('<relevant_projects>')
    for project in projects:
        pid = _xml_safe(project.get('id', 'unknown'))
        body.append(f'<project id="{pid}">{_xml_safe(json.dumps(project, ensure_ascii=False))}</project>')
    body.append('</relevant_projects>')
    if faq_match:
        answer = _xml_safe(faq_match.get('a', ''))
        trigger_tool = faq_match.get('trigger_tool')
        body.append('<suggested_response>')
        body.append(
            "The visitor's question closely matches a FAQ entry. Use this as the basis "
            f'for your answer, paraphrasing for fit: "{answer}".'
        )
        if trigger_tool:
            body.append(f' After answering, call the tool: {_xml_safe(trigger_tool)}.')
        body.append('</suggested_response>')
    body.append('</knowledge_pack>')

    try:
        max_chars = int((os.environ.get('CHAT_KNOWLEDGE_PACK_MAX_CHARS') or '16000').strip())
    except ValueError:
        max_chars = 16000
    max_chars = max(4000, min(max_chars, 50000))

    full = ''.join(head + index + body)
    if len(full) <= max_chars:
        return full
    reduced = ''.join(head + body)  # drop the enumeration index first — XML stays well-formed
    if len(reduced) <= max_chars:
        return reduced
    logger.warning(
        'Serialized knowledge_pack length %s exceeds max %s; truncating', len(reduced), max_chars
    )
    marker = '\n<!-- truncated_for_latency --></knowledge_pack>'
    return reduced[: max_chars - len(marker)] + marker
