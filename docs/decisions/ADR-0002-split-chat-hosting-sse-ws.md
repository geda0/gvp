# ADR-0002 — Split chat hosting: text SSE + voice WS on ECS/ALB; Lambda degraded

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap.)

## Context

The chat backend is one FastAPI app (`docker/chat/app/`), shipped as one container
image to two runtimes. Two transport requirements collide with the limits of API
Gateway HTTP API + Lambda:

1. **Text** streams token-by-token via Server-Sent Events. Lambda's Mangum ASGI
   adapter (`docker/chat/app/lambda_handler.py:5,9`) buffers the async generator, so
   the client receives the whole reply at once instead of streaming.
2. **Voice** (Gemini Live) needs a browser→server WebSocket upgrade, which API Gateway
   HTTP API cannot perform.

## Decision

Run text streaming and voice on **ECS Fargate behind an ALB** with `CHAT_LIVE_RELAY=1`;
keep Lambda only as a text-only / degraded / dev fallback with `CHAT_LIVE_RELAY=0`.

- SSE: `POST /api/chat` with `stream:true` returns a `StreamingResponse` of
  `text/event-stream` with `Cache-Control: no-cache` and `X-Accel-Buffering: no` so
  nginx/ALB pass tokens straight through (`main.py:778-785`). `stream:false` returns the
  legacy single JSON body (`main.py:170,790-845`).
- Routing: `GeminiRoutingChain` exposes both `ainvoke` (`gemini_routing.py:71`) and
  `astream` (`gemini_routing.py:99`); on a first-chunk rate-limit it transparently
  falls back to the secondary model, but once any chunk has flushed the chain is
  committed (`gemini_routing.py:50-55`; `main.py:877`).
- Voice: `POST /api/live/session` mints a bridge token (`main.py:961`) and the relay
  runs over `WS /api/live/relay/{bridge_id}` (`main.py:1062-1077`), proxying browser ↔
  Google Live (`live_relay.py:41-57`) — explicitly "this relay runs on a
  WebSocket-capable server" (`live_relay.py:1-7`).
- The `CHAT_LIVE_RELAY` flag default in code is **on** (`main.py:49`), but the deploy
  templates pin it per host: Lambda → `'0'` (`aws/chat-template.yaml:90`), ECS → `'1'`
  (`aws/chat-ecs-template.yaml:228`), and the Dockerfile baseline is `1`
  (`docker/chat/Dockerfile:8`).

## Consequences

- Production voice and true streaming require the ECS/ALB stack. Pointing
  `gvp:chat-api-url` at a Lambda `execute-api` host yields working text (buffered) and
  failed voice — the deploy script warns on this (README:51).
- Optional `CHAT_LIVE_VOICE_STRICT=1` makes `POST /api/live/session` return 503 when the
  relay is off, instead of minting a token that can't be used (`main.py:53,986-993`).
- One image, two env profiles: any new transport that needs an HTTP upgrade or
  unbuffered streaming belongs on ECS, not Lambda. The split is intentional, not an
  accident of packaging.
