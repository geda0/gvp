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
    'spark': {'spark', 'emr', 'apache spark', 'scala spark', 'databricks'},
    'graphql': {'graphql', 'graph ql', 'apollo'},
    'kubernetes': {'kubernetes', 'k8s', 'kube'},
    'mongodb': {'mongodb', 'mongo db', 'mongo'},
    'microservices': {'microservices', 'microservice', 'service oriented', 'soa'},
    'mentoring': {'mentoring', 'mentor', 'leadership', 'led teams', 'team lead'},
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

    matched_roles = [r for r in roles_all if _is_relevant(r, tags)][:max_roles]
    matched_projects = [p for p in projects_all if _is_relevant(p, tags)][:max_projects]
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
        'Voice mode: answer concisely for speech. About Marwan\'s work use third '
        'person (he builds, he offers, he did) — not "we". About Marwan '
        'specifically, stay grounded in the portfolio XML below — never invent '
        'employers, dates, titles, or projects. Outside of Marwan-specific claims '
        'you can talk freely about technology, science, day-to-day topics, and '
        'small talk; be a good conversational partner. Reply in the visitor\'s '
        'language and switch languages with them (Arabic, Spanish, French, etc.). '
        'Keep spoken answers short by default — a sentence or two unless asked for '
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
    xml = ''.join(parts)
    try:
        max_chars = int((os.environ.get('CHAT_KNOWLEDGE_PACK_MAX_CHARS') or '14000').strip())
    except ValueError:
        max_chars = 14000
    max_chars = max(4000, min(max_chars, 50000))
    if len(xml) > max_chars:
        logger.warning(
            'Serialized knowledge_pack length %s exceeds max %s; truncating',
            len(xml),
            max_chars,
        )
        marker = '\n<!-- truncated_for_latency -->'
        xml = xml[: max_chars - len(marker)] + marker
    return xml
