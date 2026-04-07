# Job pipeline

Semi-automated job discovery and application tracking. Ingests public listings from **Greenhouse** and **Lever** boards, scores postings with **resume-aware matching** (when `resume.json` is available) plus rule-based keywords, exposes a **review queue**, and records **applications** with templates, learned answers, and an event timeline.

## Requirements

- Python 3.11+
- Optional: PostgreSQL (default is SQLite file `jobagent.db` in this directory)

## Setup

```bash
cd job-agent
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — `sqlite:///./jobagent.db` or `postgresql+psycopg2://user:pass@localhost/jobagent`
- `GREENHOUSE_BOARD_TOKENS` — JSON array of board tokens, e.g. `["stripe"]` (from `boards.greenhouse.io/{token}`)
- `LEVER_ACCOUNT_SLUGS` — JSON array of Lever site slugs, e.g. `["leverdemo"]` (from `jobs.lever.co/{slug}`)
- `MATCH_SCORE_THRESHOLD` — minimum score (0–100) for the review queue (default 25)
- `API_KEY` — if set, send header `X-API-Key` or query `?api_key=` for all routes except `/health`
- `SYNC_INTERVAL_HOURS` — background sync interval when sources are configured
- `PROFILE_JSON_PATH` — optional path to **resume JSON** (skills, summary, experience) used to rank jobs and to fill `{{summary_line}}` in cover letters. If unset, the app looks for `../resume/resume.json` (sibling of `job-agent/` in this repo) or `job-agent/data/resume.json`.

Copy `data/matcher_rules.example.json` to `data/matcher_rules.json` and adjust keywords, boosts, and blocklists.

### Resume matching

Skills and summary from the resume JSON are matched against each job’s title and description. Roles with **no overlap** with any resume skill are heavily down-ranked (typically below the default queue threshold). Generic `must_have_any` rules still apply unless at least one resume skill matches the posting text.

### Apply profile & learning

- **`/profile`** — full name, email, optional LinkedIn/phone/work auth, **cover letter template** (`{{company}}`, `{{role}}`, `{{summary_line}}`, …), and default answers JSON.
- **Apply workspace** — if name/email are missing, a **one-time form** collects them; **Save & copy + open job** saves the profile, materializes cover letter + merged answers, then redirects with **auto-run** so the browser opens the posting and copies the clipboard in one step. After setup, **Open job & copy materials** is a single click.
- **Mark as submitted** stores the current cover letter and answer keys into **learned** storage so future applications pre-fill; a previous letter containing `{{...}}` placeholders is re-rendered for each new company.

Run migrations:

```bash
alembic upgrade head
```

## Run

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

Open `http://127.0.0.1:8080` for the dashboard, or `http://127.0.0.1:8080/docs` for OpenAPI.

**Apply workspace** (`/applications/{id}/apply`): see above — setup gate, 1-click copy + open, **Mark as submitted** to learn defaults.

## API highlights

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sync/run` | Pull configured boards, upsert postings, recompute scores |
| GET | `/api/queue` | Review queue (matched, not dismissed, no application) |
| POST | `/api/jobs/{id}/dismiss` | Hide a posting |
| POST | `/api/jobs/{id}/shortlist` | Create application (preparing) |
| POST | `/api/jobs/manual` | Add a manual posting (Workday, referrals, etc.) |
| GET/PATCH | `/api/applications/...` | CRUD + timeline events |
| GET | `/api/export/applications.csv` | CSV export of all applications |

## Notes

- Submission to employer sites is **manual** by design; the UI holds your materials and timeline.
- Respect each provider’s terms; this tool uses public job listing endpoints only.
