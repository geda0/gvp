"""Load portfolio JSON and build retrievable text chunks."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

logger = logging.getLogger(__name__)


def _strip_html(html: str) -> str:
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", text).strip()


def _chunks_from_resume(data: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    if summary := data.get("summary"):
        chunks.append(f"Resume summary: {summary}")
    for skill in data.get("skills") or []:
        chunks.append(f"Skill: {skill}")
    for exp in data.get("experience") or []:
        role = exp.get("role", "")
        company = exp.get("company", "")
        period = exp.get("period", "")
        highlights = exp.get("highlights") or []
        hl = "; ".join(str(h) for h in highlights)
        chunks.append(
            f"Experience: {role} at {company} ({period}). Highlights: {hl}"
        )
    for edu in data.get("education") or []:
        deg = edu.get("degree", "")
        school = edu.get("school", "")
        focus = edu.get("focus") or []
        chunks.append(
            f"Education: {deg} at {school}. Focus: {', '.join(str(f) for f in focus)}"
        )
    for proj in data.get("projects") or []:
        tid = proj.get("id", "")
        title = proj.get("title", "")
        blurb = proj.get("blurb", "")
        chunks.append(f"Resume project entry: {title} ({tid}). {blurb}")
    return [c for c in chunks if c.strip()]


def _chunks_from_projects(data: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    for section in ("playground", "playgroundBeta", "portfolio"):
        for item in data.get(section) or []:
            title = item.get("title", "")
            cid = item.get("id", "")
            card = item.get("cardDescription", "")
            desc = _strip_html(item.get("description", "") or "")
            tech = item.get("tech") or []
            tech_s = ", ".join(str(t) for t in tech)
            section_label = "playground beta" if section == "playgroundBeta" else section
            chunks.append(
                f"Site {section_label} project {title} ({cid}). {card} {desc} Tech: {tech_s}"
            )
    return [c for c in chunks if c.strip()]


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        logger.warning("Corpus file missing: %s", path)
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("Failed to read %s: %s", path, e)
        return {}


def build_chunks(resume_path: Path, projects_path: Path) -> list[str]:
    resume = load_json_file(resume_path)
    projects = load_json_file(projects_path)
    chunks: list[str] = []
    chunks.extend(_chunks_from_resume(resume))
    chunks.extend(_chunks_from_projects(projects))
    if not chunks:
        logger.warning("No corpus chunks built; RAG will be empty")
    return chunks


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9]+", text.lower())


class CorpusIndex:
    """In-memory BM25 over corpus chunks."""

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = list(chunks)
        tokenized = [tokenize(c) for c in self.chunks]
        self._bm25 = BM25Okapi(tokenized) if tokenized else None

    def retrieve(self, query: str, k: int = 4) -> list[str]:
        if not self.chunks or not self._bm25:
            return []
        q = tokenize(query)
        if not q:
            return self.chunks[:k]
        scores = self._bm25.get_scores(q)
        ranked = sorted(
            range(len(self.chunks)),
            key=lambda i: scores[i],
            reverse=True,
        )[:k]
        return [self.chunks[i] for i in ranked]


def summarized_corpus(chunks: list[str], max_chars: int = 12000) -> str:
    """Compact block for system prompt (truncated)."""
    body = "\n\n".join(chunks)
    if len(body) <= max_chars:
        return body
    return body[: max_chars - 20] + "\n\n[...truncated...]"
