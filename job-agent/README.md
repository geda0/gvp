# Job pipeline

FastAPI service for job discovery (Greenhouse/Lever sync), **LinkedIn bookmarklet capture**, resume-aware scoring, review queues, and a **1-click apply workspace** with profile templates and learned answers.

## Setup

```bash
cd job-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set **`API_KEY`** (required for the bookmarklet and protected UI/API). Set **`PUBLIC_BASE_URL`** to the origin you use in the bookmarklet (e.g. `http://127.0.0.1:8080`).

```bash
alembic upgrade head
uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

## LinkedIn bookmarklet

LinkedIn does not expose a personal job-feed API. Use the bookmarklet on an open job posting to POST the URL + best-effort title/company to this app.

1. Open [`static/bookmarklet.js`](static/bookmarklet.js) — set `API_KEY` and `BASE` to match your server.
2. Create a browser bookmark whose URL is the **minified** one-liner (see `/apply` page for a starter template), or wrap the IIFE in `javascript:(function(){...})();`.
3. On a LinkedIn job page, click the bookmark. You should get an alert with the saved posting id.
4. Open **`/apply`** in the dashboard — captured jobs appear with scores. Rows **meeting `MATCH_SCORE_THRESHOLD`** are separated from lower scores.

**CORS:** Responses from `POST /api/linkedin/capture` include `Access-Control-Allow-Origin` for `linkedin.com` origins so the bookmarklet can call your local server.

**DOM variance:** Selectors for company/title may break when LinkedIn changes the UI. Edit `static/bookmarklet.js` or the template snippet on `/apply` if needed.

**Security:** The bookmarklet embeds your API key. Rotate `API_KEY` if it leaks.

## Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | SQLite default or Postgres |
| `API_KEY` | Protects API + HTML (header `X-API-Key` or `?api_key=`) |
| `PUBLIC_BASE_URL` | Shown in `/apply` bookmarklet helper |
| `PROFILE_JSON_PATH` | Resume JSON for scoring + cover `{{summary_line}}` (fallback: `../resume/resume.json`) |
| `GREENHOUSE_BOARD_TOKENS` | JSON array of board tokens |
| `LEVER_ACCOUNT_SLUGS` | JSON array of Lever slugs |
| `MATCH_SCORE_THRESHOLD` | Queue + “meets threshold” section on `/apply` (default 25) |

## API highlights

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/linkedin/capture` | Bookmarklet ingest (`url`, optional `title`, `company`, `snippet`) |
| POST | `/api/sync/run` | Greenhouse/Lever sync |
| GET | `/api/queue` | ATS review queue |
| GET | `/api/export/applications.csv` | CSV export |

Open **`/docs`** for OpenAPI.

## Notes

- Applying on employer sites remains **manual**; the app prepares text and tracks status.
- Respect LinkedIn’s terms; this flow uses only what you send from an active browser session.
