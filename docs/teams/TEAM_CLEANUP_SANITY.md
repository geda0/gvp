# Team Cleanup/Sanity

**Mission:** keep the repository coherent while feature teams move fast: remove drift, enforce consistency, and prevent accidental complexity.

## Primary ownership

- [README.md](../../README.md)
- [CLAUDE.md](../../CLAUDE.md)
- [docs/parallel-phases/](../parallel-phases/README.md)
- [docs/production-readiness/](../production-readiness/README.md)
- [docs/teams/](./README.md)

## Focus areas

1. **Docs accuracy:** ensure implementation reality matches docs (ports, service names, contracts).
2. **Naming consistency:** coordinator/team naming and links stay valid.
3. **No stale references:** remove outdated terms (for example old port assumptions).
4. **Scope discipline:** keep cleanup diffs surgical; no hidden feature work.

## Worker prompt

```text
You are Team Cleanup/Sanity in /Users/marwanelgendy/workspace/PP/gvp.
Work only on docs and light consistency fixes unless coordinator approves code edits.
Find and fix drift between README, docs/parallel-phases, docs/production-readiness, and current implementation.
Avoid feature changes and keep diffs minimal.
```

## Definition of done

- [ ] High-traffic docs are accurate and cross-linked.
- [ ] No broken links in new team/coordinator docs.
- [ ] Obvious terminology drift is removed.
- [ ] Cleanup changes are isolated and reviewable.
