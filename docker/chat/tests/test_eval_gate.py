from __future__ import annotations

import json
from pathlib import Path
from typing import Any


FIXTURES_PATH = Path(__file__).parent / 'fixtures' / 'transcript-eval-cases.json'
CRITERIA_PATH = Path(__file__).resolve().parents[3] / 'docs' / 'chat-evals' / 'pass-criteria.json'

REFUSAL_TOKENS = (
    "i can't",
    'i cannot',
    'cannot help',
    "i do not have",
    "i don't have",
    "i am unable",
    "i'm unable",
    'not available in',
    'not in the portfolio',
)
HANDOFF_TOKENS = (
    'contact form',
    'reach out',
    'get in touch',
    'open resume',
    'resume button',
)


def _load_json(path: Path) -> Any:
    with path.open('r', encoding='utf-8') as fp:
        return json.load(fp)


def _contains_any(text: str, tokens: list[str] | tuple[str, ...]) -> bool:
    lower = text.lower()
    return any(token.lower() in lower for token in tokens)


def _hallucination_safe(reply: str, checks: dict[str, Any]) -> bool:
    disallowed = [str(token) for token in checks.get('disallowed_claim_tokens') or []]
    if _contains_any(reply, disallowed):
        return False

    required = [str(token) for token in checks.get('required_grounding_tokens') or []]
    if required and not _contains_any(reply, required):
        return False
    return True


def _metric_rows(cases: list[dict[str, Any]]) -> dict[str, list[bool]]:
    rows = {
        'hallucination_correctness': [],
        'refusal_correctness': [],
        'handoff_correctness': [],
    }
    for case in cases:
        reply = str(case.get('assistant_reply', ''))
        checks = case.get('checks') or {}
        expectations = case.get('expectations') or {}

        observed_hallucination_safe = _hallucination_safe(reply, checks)
        observed_hallucination_correct = observed_hallucination_safe == bool(
            expectations.get('hallucination_safe')
        )
        rows['hallucination_correctness'].append(
            observed_hallucination_correct == bool(expectations.get('hallucination_correct'))
        )

        observed_refusal = _contains_any(reply, REFUSAL_TOKENS)
        observed_refusal_correct = observed_refusal == bool(expectations.get('should_refuse'))
        rows['refusal_correctness'].append(
            observed_refusal_correct == bool(expectations.get('refusal_correct'))
        )

        observed_handoff = _contains_any(reply, HANDOFF_TOKENS)
        observed_handoff_correct = observed_handoff == bool(expectations.get('should_handoff'))
        rows['handoff_correctness'].append(
            observed_handoff_correct == bool(expectations.get('handoff_correct'))
        )
    return rows


def _version_summary(cases: list[dict[str, Any]], rows: dict[str, list[bool]]) -> dict[str, dict[str, float]]:
    by_version: dict[str, dict[str, list[bool]]] = {}
    for index, case in enumerate(cases):
        version = str(case.get('prompt_version') or 'unknown')
        version_rows = by_version.setdefault(
            version,
            {
                'hallucination_correctness': [],
                'refusal_correctness': [],
                'handoff_correctness': [],
            },
        )
        for metric in version_rows.keys():
            version_rows[metric].append(rows[metric][index])

    summary: dict[str, dict[str, float]] = {}
    for version, metrics in by_version.items():
        summary[version] = {}
        for metric, outcomes in metrics.items():
            summary[version][metric] = sum(1 for ok in outcomes if ok) / max(1, len(outcomes))
    return summary


def test_eval_gate_pass_criteria() -> None:
    cases = _load_json(FIXTURES_PATH)
    criteria = _load_json(CRITERIA_PATH)

    assert isinstance(cases, list) and len(cases) > 0
    rows = _metric_rows(cases)
    required_metrics = criteria.get('required_metrics') or {}

    for metric, rule in required_metrics.items():
        outcomes = rows.get(metric, [])
        assert len(outcomes) >= int(rule.get('minimum_cases', 1)), (
            f'{metric} has {len(outcomes)} cases, requires at least {rule.get("minimum_cases")}'
        )
        pass_rate = sum(1 for ok in outcomes if ok) / max(1, len(outcomes))
        min_rate = float(rule.get('minimum_rate', 1.0))
        assert pass_rate >= min_rate, (
            f'{metric} pass rate {pass_rate:.2%} is below {min_rate:.2%}'
        )


def test_eval_cases_include_good_and_bad_examples() -> None:
    cases = _load_json(FIXTURES_PATH)
    labels = {str(case.get('label', '')).lower() for case in cases}
    assert 'good' in labels
    assert 'bad' in labels


def test_eval_outputs_version_comparisons() -> None:
    cases = _load_json(FIXTURES_PATH)
    rows = _metric_rows(cases)
    summary = _version_summary(cases, rows)

    assert '1.0.0' in summary
    assert '1.0.1' in summary
    for metrics in summary.values():
        assert set(metrics.keys()) == {
            'hallucination_correctness',
            'refusal_correctness',
            'handoff_correctness',
        }
