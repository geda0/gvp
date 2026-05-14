# Parallel phase work — three team briefs

Use these documents to split work across **three agents or squads** working **in parallel** on the Docker stack, the LangChain chatbot backend, and the UI.

| Phase / team | Document | Focus |
|--------------|----------|--------|
| 1 — Docker | [TEAM_DOCKER.md](./TEAM_DOCKER.md) | `docker compose`, proxy, mocks, **verified smoke tests**, handoff URLs |
| 2 — Chatbot | [TEAM_CHATBOT.md](./TEAM_CHATBOT.md) | LangChain, **Gemini free tier** + mock, RAG, **test matrix** |
| 3 — UI | [TEAM_UI.md](./TEAM_UI.md) | Hero-first chat, **usable + creative**, a11y, both themes |

**Coordination:** Agree early on `POST /api/chat` JSON shape and `/api/contact` mock behavior; Docker team wires paths last once contracts are stable.

**Production handoff:** [docs/production-readiness/README.md](../production-readiness/README.md) — coordinator-led squads and release checklist.
