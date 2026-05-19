# GVP architecture

Architecture reference for **Marwan Elgendy's portfolio** (`gvp`): a static site on **AWS Amplify**, a durable **contact pipeline** (SAM), and a **Gemini-backed chat API** (Lambda for text, ECS + ALB for voice WebSockets).

Diagrams use [Mermaid](https://mermaid.js.org/). They render on GitHub, in many IDEs, and in viewers that support fenced `mermaid` blocks.

**Related docs:** [`README.md`](../README.md) (run/deploy), [`CLAUDE.md`](../CLAUDE.md) (module map), [`docs/production-readiness/`](production-readiness/README.md) (release checklists).

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Frontend (static site)](#2-frontend-static-site)
3. [Contact pipeline](#3-contact-pipeline)
4. [Chat (text + voice)](#4-chat-text--voice)
5. [Deployment topology](#5-deployment-topology)
6. [Data and assets](#6-data-and-assets)
7. [Strengths and constraints](#7-strengths-and-constraints)
8. [Key file map](#8-key-file-map)

---

## 1. System overview

The browser loads static HTML/CSS/JS from Amplify. API base URLs come from `<meta>` tags (patched after deploy by `scripts/sync-site-api-urls.mjs`). Contact and chat admin share one HTTP API on the **contact SAM stack**; chat traffic for production text and all voice goes to **ECS behind an ALB**.

```mermaid
flowchart TB
    subgraph Browser["🌐 Browser"]
        UI["index.html + admin/"]
        META["meta: gvp:contact-api-url<br/>meta: gvp:chat-api-url"]
    end

    subgraph Static["☁️ AWS Amplify"]
        CDN["Static hosting<br/>marwanelgendy.link"]
    end

    subgraph ContactStack["📬 Contact SAM stack (page)"]
        CAPI["HTTP API Gateway"]
        ING["contact-ingress λ"]
        DDB1[("ContactMessages<br/>DynamoDB")]
        SQS["SQS queue"]
        SND["contact-sender λ"]
        ADM["contact-admin λ"]
        DDB2[("ChatTranscripts<br/>DynamoDB")]
    end

    subgraph ChatText["💬 Chat Lambda stack"]
        CHAPI["HTTP API Gateway"]
        CHL["FastAPI container λ<br/>CHAT_LIVE_RELAY=0"]
    end

    subgraph ChatVoice["🎙️ Chat ECS stack"]
        ALB["Application Load Balancer<br/>chat-api.marwanelgendy.link"]
        ECS["Fargate FastAPI<br/>CHAT_LIVE_RELAY=1"]
    end

    subgraph External["🔗 External"]
        RESEND["Resend email"]
        GEMINI["Google Gemini API"]
        GA["Google Analytics"]
    end

    UI --> CDN
    META -.-> UI
    UI -->|"POST /api/contact"| CAPI
    UI -->|"POST /api/chat (SSE stream)"| ALB
    UI -->|"WS /api/live/relay (voice)"| ALB
    UI --> GA

    CAPI --> ING --> DDB1 --> SQS --> SND --> RESEND
    CAPI --> ADM --> DDB1
    ADM --> DDB2

    CHAPI --> CHL --> GEMINI
    ALB --> ECS --> GEMINI
    ECS --> DDB2

    classDef browser fill:#6366F1,stroke:#4338CA,color:#fff
    classDef static fill:#10B981,stroke:#059669,color:#fff
    classDef contact fill:#F59E0B,stroke:#D97706,color:#000
    classDef chat fill:#EC4899,stroke:#DB2777,color:#fff
    classDef voice fill:#8B5CF6,stroke:#7C3AED,color:#fff
    classDef external fill:#64748B,stroke:#475569,color:#fff
    classDef db fill:#0EA5E9,stroke:#0284C7,color:#fff

    class UI,META browser
    class CDN static
    class CAPI,ING,SQS,SND,ADM contact
    class CHAPI,CHL chat
    class ALB,ECS voice
    class RESEND,GEMINI,GA external
    class DDB1,DDB2 db
```

### Design choice: split chat hosting

| Path | Host | Why |
|------|------|-----|
| **Text** (`POST /api/chat`, SSE) | ECS + ALB (prod) | Streaming HTTP — token-by-token UX requires unbuffered responses. Lambda accepts the same requests but Mangum buffers the SSE generator, so the user sees the full reply at once. Use Lambda only for dev or as a degraded fallback. |
| **Voice** (`POST /api/live/session`, `WS /api/live/relay/{id}`) | **ECS + ALB only** | API Gateway HTTP API cannot upgrade browser WebSockets for Gemini Live relay |

Contact admin and chat transcript admin routes live on the **same** contact HTTP API and use the same `x-admin-key` (`ADMIN_API_KEY`). The chat host also exposes a gated diagnostic at `GET /api/chat/host-status` for the admin SPA — same secret, but checked inside the FastAPI app rather than the admin Lambda.

---

## 2. Frontend (static site)

No bundler: ES modules from `js/app.js`, theme via `data-theme` on `<html>`, hash routing (`#home`, `#playground`, `#portfolio`).

```mermaid
flowchart LR
    subgraph Entry["Entry"]
        HTML["index.html"]
        APP["js/app.js<br/>(orchestrator)"]
    end

    subgraph Config["Config & routing"]
        SC["site-config.js<br/>reads meta tags"]
        NAV["navigation.js<br/>hash routing"]
        THEME["theme.js<br/>space · garden · studio · auto"]
    end

    subgraph Visual["Visual layer"]
        SF["starfield.js<br/>canvas: stars / snow"]
        SP["spaceman.js<br/>state machine + typed messages"]
        SPP["spaceman-position.js<br/>observers + drag"]
    end

    subgraph Telemetry["Telemetry"]
        AN_JS["analytics.js<br/>gtag + outbound tracking"]
    end

    subgraph Content["Content"]
        PROJ["projects.js<br/>data/projects.json"]
        SPC["spaceman-project-context.js<br/>playground/portfolio card context"]
    end

    subgraph ChatUI["Chat surface"]
        AN["agent-node.js<br/>hero bubble + navbar slot"]
        CH["chat.js<br/>dialog, chips, composer"]
        CL["chat-live.js<br/>mic + voice pane"]
        CB["chat-bus.js"]
    end

    subgraph Forms["Forms & admin"]
        CF["contact.js"]
        ADM["admin.js + admin/"]
    end

    subgraph Data["JSON data"]
        PJ["projects.json"]
        SM["spaceman.json"]
        RS["resume/resume.json"]
        CK["data/chat-knowledge/*"]
    end

    HTML --> APP
    APP --> SC & NAV & THEME & SF & SP & SPP & PROJ & SPC & CF & CH & AN & AN_JS
    CH --> CL & CB
    SP --> SM & RS
    PROJ --> PJ
    SPC --> PJ
    CH -.->|"grounded answers"| CK

    classDef entry fill:#6366F1,stroke:#4338CA,color:#fff
    classDef core fill:#3B82F6,stroke:#2563EB,color:#fff
    classDef visual fill:#14B8A6,stroke:#0D9488,color:#fff
    classDef chat fill:#EC4899,stroke:#DB2777,color:#fff
    classDef data fill:#F59E0B,stroke:#D97706,color:#000
    classDef tel fill:#94A3B8,stroke:#64748B,color:#fff

    class HTML,APP entry
    class SC,NAV,THEME,PROJ,CF core
    class SF,SP,SPP,SPC visual
    class AN,CH,CL,CB chat
    class PJ,SM,RS,CK data
    class AN_JS tel
```

### Boot order (`app.js`)

1. `initAnalytics()` — gtag; virtual `page_view` on navigation
2. `bindOutboundTracking()` — `[data-track]` elements
3. `initTheme()` — `localStorage` key `gvp-theme`
4. `initStarfield()` — canvas background
5. `initContactForm()` — contact dialog
6. `initSpaceman()` — character + message cycle from `/data/spaceman.json` + resume merge
7. `initSpacemanPosition()` — layout observers
8. `initChat()` + `initAgentNode()` — hero/navbar chat + full dialog
9. `initNavigation()` — hash routes; hooks spaceman state
10. `loadProjects()` / `renderProjects()` — `data/projects.json`
11. `initSpacemanProjectContext()` — playground/portfolio card context

### Themes

| Preference | Resolved theme | Canvas / scene |
|------------|----------------|----------------|
| `space` | Space | 3D starfield, motion streaks |
| `garden` | Garden | Snow + DOM garden scene (sky, trees, ocean) |
| `studio` | Studio | Paper-like, low distraction |
| `auto` | `space` (dark) or `garden` (light) | Follows `prefers-color-scheme` via `resolveAuto()` in [`js/theme.js`](../js/theme.js) |

### API URL resolution (`site-config.js`)

- `gvp:contact-api-url` → `contactApiUrl` (local fallback: `/api/contact`)
- `gvp:chat-api-url` → `chatApiUrl` (local fallback: `/api/chat`)
- Also exposed as `window.__CONTACT_API_URL__` and `window.__CHAT_API_URL__` for admin

---

## 3. Contact pipeline

**Success** = message persisted in DynamoDB and enqueued before the UI shows success. Delivery is async via SQS + sender Lambda + Resend.

### Submit flow

```mermaid
sequenceDiagram
    autonumber
    participant U as Visitor
    participant FE as contact.js
    participant API as HTTP API
    participant IN as contact-ingress λ
    participant DB as DynamoDB
    participant Q as SQS
    participant SE as contact-sender λ
    participant R as Resend

    U->>FE: Submit form (honeypot field)
    FE->>API: POST /api/contact
    API->>IN: Validate JSON + CORS

    alt Honeypot filled (bot)
        IN-->>FE: 200 ok (silent discard)
    else Valid message
        IN->>DB: PutItem (status: queued)
        IN->>Q: Enqueue delivery job
        IN-->>FE: 200 { persisted, queued }
        FE-->>U: Success UI ✓

        Q->>SE: Poll batch (up to 10)
        SE->>R: fetch() send email
        alt Resend OK
            SE->>DB: status → sent
        else Resend fail
            SE->>DB: attempts++, status failed
            Note over Q: Retry up to 5× → DLQ
        end
    end

    rect rgb(255, 237, 213)
        Note over DB,Q: Message is durable after PutItem + enqueue —<br/>survives Resend outages
    end
```

### SAM resources (`aws/template.yaml`)

| Resource | Role |
|----------|------|
| `ContactApi` | HTTP API, CORS, throttling (stricter on admin routes) |
| `ContactMessagesTable` | Primary store; GSI `byCreatedAt` (`listPk` + `createdAt`) |
| `ChatTranscriptsTable` | Chat logs; same GSI pattern as contact messages |
| `ContactDeliveryQueue` | Async delivery; redrive to DLQ after 5 receives |
| `ContactIngressFunction` | `POST /api/contact` |
| `ContactSenderFunction` | SQS trigger → Resend |
| `ContactFailureReportFunction` | Daily cron → email summary of failures |
| `ContactAdminFunction` | Admin + chat transcript admin routes |
| `ContactDlqAlarm` | SNS → `ALARM_EMAIL` when DLQ has messages |

### Admin surface

```mermaid
flowchart TB
    subgraph Admin["🔐 admin/index.html"]
        AUI["admin.js<br/>x-admin-key header"]
        UI_CARDS["Cards: streamed sessions ·<br/>avg first-token · stream failures ·<br/>fallback model · activity sparkline ·<br/>recent failures (clickable)"]
    end

    subgraph Routes["Admin API routes"]
        SUM["GET /api/contact/admin/summary"]
        MSG["GET /api/contact/admin/messages?cursor"]
        RET["POST /api/contact/admin/retry/{id}"]
        TRN["GET /api/chat/admin/transcripts"]
        TRN_SUM["GET /api/chat/admin/transcripts/summary<br/>(stream rollups + recentFailures)"]
        HOST["GET /api/chat/host-status<br/>(chat ECS, x-admin-key)"]
    end

    subgraph Ops["Background ops"]
        RPT["contact-report λ<br/>daily cron 12:00 UTC"]
        ALM["CloudWatch → SNS → email<br/>DLQ alarm"]
    end

    AUI --> UI_CARDS
    AUI --> Routes
    Routes --> DDB[("DynamoDB<br/>GSI byCreatedAt")]
    HOST --> CHATHOST["chat ECS<br/>TranscriptStore.stats()"]
    RPT --> DDB
    ALM --> DLQ["SQS DLQ"]

    classDef admin fill:#EF4444,stroke:#DC2626,color:#fff
    classDef route fill:#F97316,stroke:#EA580C,color:#fff
    classDef ops fill:#84CC16,stroke:#65A30D,color:#000

    class AUI,UI_CARDS admin
    class SUM,MSG,RET,TRN,TRN_SUM,HOST route
    class RPT,ALM ops
```

**Contact admin routes:** `summary`, `messages` (paginated `?limit` + `?cursor`), `messages/{id}`, `health`, `retry/{id}`, `suppress-report`.

**Chat admin routes (same API):** `transcripts`, `transcripts/{id}`, `note`, `reviewed`, `transcripts/summary`.

**Chat host diagnostic (separate origin):** `GET /api/chat/host-status` on the chat ECS task. Returns provider name, configured/primary/fallback/last model ids, prompt version, provider timeout, and live `TranscriptStore` counters (`writes_attempted`, `_succeeded`, `_failed`, `last_error`, `last_success_at`). Gated by `ADMIN_API_KEY` env on the chat container; degrades gracefully when unset (401, panel keeps working off the DDB rollups).

#### Chat transcripts summary payload

The `/api/chat/admin/transcripts/summary` response is what the dashboard renders into cards and the sparkline. Top-level shape:

```json
{
  "tableName": "...", "total": 7, "reviewed": 1, "unreviewed": 6, "flagged": 0,
  "byPromptVersion": { "1.4.0": 7 },
  "byFlag": { "no_retrieval_match": 0, "negative_feedback": 0, ... },
  "voice":  { "sessions": 2, "voiceTurns": 8, "textTurns": 14, "avgTextLatencyMs": 5800, ... },
  "stream": {
    "streamedSessions": 5, "streamedTurns": 12,
    "streamFailures": 2, "streamTimeouts": 1,
    "fallbackTurns": 3,
    "avgFirstTokenLatencyMs": 610, "avgOutputChars": 145,
    "errorsByCode": { "upstream_timeout": 1, "model_error": 1 },
    "recentFailures": [
      { "capturedAt": "...", "errorCode": "upstream_timeout",
        "errorMessage": "...", "status": "timeout", "stream": true,
        "latencyMs": 28000, "sessionId": "..." }
    ]
  },
  "activityByDay": { "YYYY-MM-DD": <count>, ... },
  "activeDays": 30
}
```

`recentFailures` is capped at 20 (newest first); each row is clickable in the panel and jumps to the originating transcript.

---

## 4. Chat (text + voice)

FastAPI app in `docker/chat/app/` (same image for Lambda and ECS). Knowledge from `data/chat-knowledge/` (built by `scripts/build-chat-knowledge.mjs`).

```mermaid
flowchart TB
    subgraph FE["Browser chat UI"]
        HERO["agent-node (hero/navbar)"]
        DIALOG["chat dialog"]
        VOICE["chat-live.js<br/>mic + halos"]
    end

    subgraph TextPath["📝 Text chat path (SSE)"]
        POST["POST /api/chat<br/>{ messages[], stream:true }"]
        ROUTE["gemini_routing.py<br/>astream — primary,<br/>fallback on rate limit"]
        KC["knowledge_context.py<br/>bio · roles · projects · faq"]
        EV_TOK["event: token<br/>{ delta }"]
        EV_DONE["event: done<br/>{ reply, model, actions }"]
        EV_ERR["event: error<br/>{ error, code }"]
    end

    subgraph VoicePath["🎙️ Voice path (ECS only)"]
        SESS["POST /api/live/session<br/>mint bridge token"]
        WS["WebSocket /api/live/relay/{id}"]
        RELAY["live_relay.py<br/>browser ↔ Google Live API"]
        LIVE["Gemini Live model<br/>gemini-3.1-flash-live-preview"]
    end

    subgraph Store["Persistence (every turn — ok / error / timeout)"]
        TS["transcript_store.py<br/>writes_attempted / _succeeded / _failed"]
        TBL[("ChatTranscripts<br/>DynamoDB")]
        HOST["GET /api/chat/host-status<br/>(x-admin-key)"]
    end

    HERO --> DIALOG
    DIALOG --> POST
    VOICE --> SESS --> WS

    POST --> KC --> ROUTE
    ROUTE -->|"per chunk"| EV_TOK
    ROUTE -->|"complete"| EV_DONE
    ROUTE -->|"timeout/upstream error"| EV_ERR
    WS --> RELAY --> LIVE

    EV_DONE --> TS --> TBL
    EV_ERR --> TS
    WS --> TS
    TS -.->|"stats()"| HOST

    subgraph Hosts["Where it runs"]
        LAMBDA["Lambda container<br/>aws/chat-template.yaml<br/>CHAT_LIVE_RELAY=0<br/>(buffers SSE)"]
        FARGATE["ECS Fargate + ALB<br/>aws/chat-ecs-template.yaml<br/>CHAT_LIVE_RELAY=1<br/>(true streaming)"]
    end

    POST -.->|"production"| FARGATE
    WS --> FARGATE
    POST -.->|"degraded / dev"| LAMBDA

    classDef fe fill:#6366F1,stroke:#4338CA,color:#fff
    classDef text fill:#06B6D4,stroke:#0891B2,color:#fff
    classDef voice fill:#A855F7,stroke:#9333EA,color:#fff
    classDef store fill:#0EA5E9,stroke:#0284C7,color:#fff
    classDef host fill:#64748B,stroke:#475569,color:#fff

    class HERO,DIALOG,VOICE fe
    class POST,ROUTE,KC,EV_TOK,EV_DONE,EV_ERR text
    class SESS,WS,RELAY,LIVE voice
    class TS,TBL,HOST store
    class LAMBDA,FARGATE host
```

### Streaming behavior

- **Request:** `{ messages, stream: true, sessionId }`. Backwards-compat: `stream: false` returns a single JSON body (used by Lambda fallback and existing callers).
- **Response when `stream:true`:** `text/event-stream` with `Cache-Control: no-cache` and `X-Accel-Buffering: no` so nginx/ALB pass tokens straight through.
- **Routing:** `GeminiRoutingChain.astream` tries the primary model; if the *first* chunk fails with a rate-limit, it transparently retries on the fallback. Once any chunk has flushed, the chain is committed — mid-stream errors propagate as `event: error`.
- **Budget:** single `astream` deadline (`provider_timeout_seconds`, default 28s for Gemini) wrapped with per-chunk `asyncio.wait_for` so the streaming path stays portable to Python 3.10 (`asyncio.timeout` is 3.11+).
- **Failure persistence:** every turn — success, timeout, or upstream error — writes a row before returning. The error variants carry `status`, `errorCode`, `errorMessage`, and any partial reply so the admin panel can see what happened.

### Turn telemetry (DynamoDB `turns[]` entries)

Each `persist_turn` call appends one element to the session's `turns` list. Fields populated for text:

| Field | Type | Meaning |
|-------|------|---------|
| `capturedAt` | ISO-8601 | When the turn was persisted |
| `modality` | `text` / `voice` | Splits the table without sniffing fields |
| `stream` | bool | Was SSE used? |
| `status` | `ok` / `error` / `timeout` | Terminal state of the attempt |
| `firstTokenLatencyMs` | int | Wall-clock to first non-empty delta (streaming only) |
| `streamChunkCount` | int | Number of chunks the chain yielded |
| `latencyMs` | int | Total round-trip the chat host observed |
| `outputCharCount` | int | `len(reply)` — cheap proxy for output tokens |
| `fallbackUsed` | bool | True when the secondary model produced the answer |
| `errorCode` / `errorMessage` | str | Set only on non-`ok` turns (truncated to 400 chars) |
| `toolCalls` / `actions` | list | Surfaced model tool invocations |
| `retrieval` | object | FAQ id + role/project ids the knowledge pack matched |
| `flags` | object | Heuristic flags (`no_retrieval_match`, etc.) |

Voice turns carry `transport`, `audioInBytes`, `audioOutBytes`, `turnDurationMs`, `interrupted`, `intent` instead of the stream fields (see [`live_relay.py`](../docker/chat/app/live_relay.py) + `POST /api/live/transcript`).

### Models (defaults in SAM)

| Use | Parameter / env | Default |
|-----|-----------------|---------|
| Text primary | `GEMINI_MODEL` | `gemini-3.1-flash-lite` |
| Text fallback | `GEMINI_FALLBACK_MODEL` | `gemma-4-26b-a4b-it` |
| Live voice | `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` |
| Live voice override | `CHAT_VOICE_MODEL` | _(empty — when set, overrides `GEMINI_LIVE_MODEL` at runtime)_ |

### Voice behavior

- Mic UI is **always** in the frontend (no feature flag).
- `CHAT_LIVE_RELAY=1` on ECS: server relays browser WebSocket ↔ Google Live.
- `CHAT_LIVE_RELAY=0` on Lambda: text works; voice fails at network level (browser may see 1011 on execute-api hosts).
- Optional `CHAT_LIVE_VOICE_STRICT=1`: `POST /api/live/session` returns **503** when relay is off.

### Local Docker (single origin)

`docker compose up` → nginx `:8080` serves static files and proxies:

| Path | Upstream |
|------|----------|
| `/` | Repo root (static) |
| `/api/contact` | `mock-contact:8001` |
| `/api/chat`, `/api/live/*` | `chat:8000` (`CHAT_PROVIDER=mock` by default) |

See [`docker/nginx.conf`](../docker/nginx.conf) for WebSocket upgrade headers on live routes.

---

## 5. Deployment topology

```mermaid
flowchart TB
    subgraph Dev["💻 Local dev"]
        DC["docker compose up"]
        NGX["nginx :8080<br/>single origin"]
        MOCK["mock-contact :8001"]
        CHATD["chat :8000<br/>CHAT_PROVIDER=mock"]
        STATIC["repo root → /usr/share/nginx/html"]
    end

    subgraph CI["⚙️ GitHub Actions"]
        EVAL["chat-eval-gate<br/>pytest + eval gate"]
        DEPLOY["integrate-and-deploy.sh"]
        SYNC["sync-site-api-urls.mjs<br/>patch meta tags"]
    end

    subgraph Stacks["AWS SAM stacks"]
        S1["page / page-staging<br/>aws/template.yaml"]
        S2["chat Lambda<br/>aws/chat-template.yaml"]
        S3["chat ECS<br/>aws/chat-ecs-template.yaml"]
    end

    subgraph Secrets["🔑 Secrets"]
        SM["Secrets Manager<br/>(optional manifests)"]
        ENV[".secrets/deploy.env<br/>.secrets/chat-deploy.env"]
    end

    DC --> NGX
    NGX --> STATIC & MOCK & CHATD

    EVAL --> DEPLOY
    ENV --> DEPLOY
    SM -.-> DEPLOY
    DEPLOY --> S1 & S2 & S3
    DEPLOY --> SYNC
    SYNC -->|"gvp:contact-api-url<br/>gvp:chat-api-url"| AMP["Amplify static site"]

    classDef dev fill:#22C55E,stroke:#16A34A,color:#fff
    classDef ci fill:#3B82F6,stroke:#2563EB,color:#fff
    classDef stack fill:#F59E0B,stroke:#D97706,color:#000
    classDef secret fill:#EF4444,stroke:#DC2626,color:#fff

    class DC,NGX,MOCK,CHATD,STATIC dev
    class EVAL,DEPLOY,SYNC ci
    class S1,S2,S3 stack
    class SM,ENV secret
```

### Deploy environments

| Target | Contact stack | Chat (typical prod) | Meta sync |
|--------|---------------|---------------------|-----------|
| `prod` | `SAM_STACK_NAME` → `page` | ECS ALB → e.g. `chat-api.marwanelgendy.link` | `CHAT_PROD_CHAT_API_URL` or ALB auto-discover |
| `stage` | `SAM_STACK_NAME_STAGE` → `page-staging` | Same pattern, stage suffix | `CHAT_STAGE_CHAT_API_URL` or Lambda `ChatPostApiUrl` |

**Entrypoint:** `bash scripts/integrate-and-deploy.sh [prod|stage]`

**Voice ECS bootstrap** (`CHAT_VOICE_ECS_BOOTSTRAP=1`, default): auto ECR repo `gvp-chat`, VPC/subnet discovery, stack names `gvp-chat-ecs-{stage,prod}`. Opt out: `CHAT_VOICE_ECS_BOOTSTRAP=0` (Lambda-only chat; voice will not work).

**Secrets:** copy from [`secrets.example/`](../secrets.example/README.md) → `.secrets/deploy.env` (+ optional `chat-deploy.env`). CI uses repository secrets with the same names.

**HTML sync:** `node scripts/sync-site-api-urls.mjs` patches `<meta name="gvp:contact-api-url">` and `<meta name="gvp:chat-api-url">` in `index.html` and `admin/index.html`.

---

## 6. Data and assets

```mermaid
flowchart LR
    subgraph Sources["Authoring sources"]
        RJ["resume/resume.json"]
        PJ["data/projects.json"]
        SJ["data/spaceman.json"]
        BS["bio.source.json"]
    end

    subgraph Build["Build step"]
        BCK["build-chat-knowledge.mjs"]
        PACK["data/chat-knowledge/<br/>bio · roles · projects · faq"]
    end

    subgraph Runtime["Runtime consumers"]
        FE2["Frontend<br/>project cards · spaceman messages"]
        CHAT2["FastAPI<br/>context injection"]
        PDF["Marwan_Elgendy_Resume_public.pdf"]
    end

    RJ & PJ --> FE2
    RJ & PJ & BS --> BCK --> PACK --> CHAT2
    RJ --> PDF

    classDef src fill:#FDE68A,stroke:#F59E0B,color:#000
    classDef build fill:#A7F3D0,stroke:#10B981,color:#000
    classDef run fill:#BFDBFE,stroke:#3B82F6,color:#000

    class RJ,PJ,SJ,BS src
    class BCK,PACK build
    class FE2,CHAT2,PDF run
```

**Site images:** `data/projects.json` references `.webp` / `.jpeg` assets at repo root (e.g. `ibm.webp`, `rpi.jpg`). **Resume link:** `resume/Marwan_Elgendy_Resume_public.pdf`.

---

## 7. Strengths and constraints

### Strengths

1. **Durable contact** — persist before enqueue; async delivery with DLQ and daily failure report.
2. **Durable chat telemetry** — every text turn (success, error, or timeout) writes a row before the user-visible response returns, so failed attempts surface in the admin panel instead of vanishing into ECS logs.
3. **No frontend bundler** — ES modules, fast iteration; meta tags for API URLs.
4. **Split chat hosting** — Lambda optional for text; ECS where WebSockets are required.
5. **Grounded AI** — answers tied to resume/project knowledge pack, not generic fluff.
6. **Single-origin local dev** — nginx mirrors production CORS and proxy paths on `:8080`.

### Constraints

| Constraint | Impact |
|------------|--------|
| Lambda has no WS upgrade | Voice fails on `execute-api` URLs |
| Lambda + Mangum buffer SSE | Streaming works but the client sees the full reply at once, not token-by-token |
| No bundler | Must serve over HTTP (`file://` breaks module imports) |
| Shared admin API | Contact + chat transcript admin use same `x-admin-key` |
| Host-status endpoint needs key in chat env | Until `ADMIN_API_KEY` is set on the chat container the diagnostic returns 401; the admin panel just falls back to DDB-only rollups |
| Throttling | HTTP API stage limits (e.g. 5 req/s) on public routes |

### Frontend performance notes

- **Garden snow** uses a pre-rendered radial-gradient sprite in `js/starfield.js`; the snow loop is one `drawImage` per flake (~3–5× cheaper than the previous per-frame `createRadialGradient`).
- **Visual-viewport sync** (mobile garden scene) is RAF-coalesced and skips style writes when nothing changed — see `applyVisualViewportSync` in [`js/app.js`](../js/app.js).
- **Garden trees** rely on trunk box-shadows + color contrast rather than `filter: drop-shadow()` on the foliage triangles (drop-shadow forces a composited layer per element).

---

## 8. Key file map

| Area | Path |
|------|------|
| Site entry | `index.html`, `js/app.js` |
| API config | `js/site-config.js`, meta tags in `index.html` |
| Chat FE | `js/chat.js` (SSE parser `readSseChat`), `js/agent-node.js`, `js/chat-live.js`, `js/chat-bus.js` |
| Contact SAM | `aws/template.yaml`, `aws/src/contact-*.js` |
| Chat Lambda SAM | `aws/chat-template.yaml` |
| Chat ECS SAM | `aws/chat-ecs-template.yaml` |
| Chat app | `docker/chat/app/main.py` (SSE `_chat_stream` + `_persist_text_turn`), `gemini_routing.py` (`astream` w/ fallback), `transcript_store.py`, `knowledge_context.py`, `live_relay.py` |
| Deploy | `scripts/integrate-and-deploy.sh`, `scripts/sync-site-api-urls.mjs` |
| Local stack | `docker-compose.yml`, `docker/nginx.conf` |
| Admin UI | `admin/index.html`, `js/admin.js` (renders cards + sparkline + recent failures), `css/admin.css` |
| Admin Lambda | `aws/src/contact-admin.js` (`normalizeChatItem` + `getChatSummary` build the stream rollups) |
| Knowledge build | `scripts/build-chat-knowledge.mjs`, `data/chat-knowledge/` |

---

*Last updated: May 2026 — streaming SSE + per-turn telemetry + admin stream-rollups added; static hosting on AWS Amplify.*
