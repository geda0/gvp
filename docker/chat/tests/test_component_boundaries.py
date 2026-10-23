"""M5 (ADR-0018) - component boundaries for docker/chat/app, fenced where the modules live.

The plan's layout (models / voice / assistant / harness / leaf infra) is enforced as an
ADDRESS MAP over the existing flat modules rather than by moving files: the fence is what makes
the layout real, and moving files would only churn the paths other work is editing. Every
import - including ones inside functions, which is where this app hides its lazy imports - is
read from the AST. A module missing from the map fails the test, so a new module has to be
placed before it can land.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / 'app'

COMPONENT = {
    # leaf infra: shared plumbing, imports no other component
    'alerts': 'leaf', 'transcript_store': 'leaf', 'secret_resolver': 'leaf', 'messages': 'leaf',
    'project_refs': 'leaf',  # M4: the shared project-id tuple, imported by voice AND assistant
    # models: the switchable model layer
    'gemini_routing': 'models', 'gemini_limit_state': 'models', 'upstream_errors': 'models',
    # voice: Gemini Live
    'live_gemini': 'voice', 'live_env': 'voice',
    # assistant: knowledge, site awareness, prompt/provider assembly, turn input
    'knowledge_context': 'assistant', 'site_state': 'assistant', 'providers': 'assistant',
    'turn_input': 'assistant',
    # harness: HTTP entry points
    'main': 'harness', 'lambda_handler': 'harness',
}

# component -> components it may import (itself always allowed)
ALLOWED = {
    'leaf': {'leaf'},
    'models': {'leaf'},
    'voice': {'leaf'},
    'assistant': {'leaf', 'models'},
    'harness': {'leaf', 'models', 'voice', 'assistant'},
}


def _app_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding='utf-8'))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ''
            if node.level and mod:  # from .x import y
                out.add(mod.split('.')[0])
            elif node.level and not mod:  # from . import x
                out.update(a.name.split('.')[0] for a in node.names)
            elif mod.startswith('app.'):
                out.add(mod.split('.')[1])
            elif mod == 'app':
                out.update(a.name.split('.')[0] for a in node.names)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith('app.'):
                    out.add(a.name.split('.')[1])
    return out


def _modules() -> list[str]:
    return sorted(p.stem for p in APP.glob('*.py') if p.stem != '__init__')


def test_every_module_has_an_address():
    unplaced = [m for m in _modules() if m not in COMPONENT]
    assert unplaced == [], f'place these in COMPONENT before they land: {unplaced}'


def test_components_import_only_what_their_layer_allows():
    broken = []
    for mod in _modules():
        src = COMPONENT.get(mod)
        if src is None:
            continue
        for dep in sorted(_app_imports(APP / f'{mod}.py')):
            dst = COMPONENT.get(dep)
            if dst is None or dst == src:
                continue
            if dst not in ALLOWED[src]:
                broken.append(f'{mod} ({src}) imports {dep} ({dst})')
    assert broken == [], 'component boundary crossed:\n' + '\n'.join(broken)


def test_models_never_reach_assistant_voice_or_the_harness():
    """The plan's headline rule, stated on its own so it survives edits to ALLOWED."""
    for mod in _modules():
        if COMPONENT.get(mod) != 'models':
            continue
        reached = {COMPONENT.get(d) for d in _app_imports(APP / f'{mod}.py')}
        assert not reached & {'assistant', 'voice', 'harness'}, f'{mod} reaches {reached}'
