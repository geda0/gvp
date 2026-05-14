# Team Platform/Edge

**Mission:** harden runtime topology and edge behavior so the deployment is safe, reproducible, and observable in production.

**Primary ownership**

- [docker-compose.yml](../../docker-compose.yml)
- [docker/nginx.conf](../../docker/nginx.conf)
- [docker/mock-contact/](../../docker/mock-contact/)
- [docs/production-readiness/COORDINATOR-PLATFORM-INFRA.md](../production-readiness/COORDINATOR-PLATFORM-INFRA.md)

## Focus areas

1. **Image policy:** pin versions/digests for deterministic builds.
2. **Edge behavior:** TLS termination strategy and security headers.
3. **Health model:** proxy and upstream readiness checks.
4. **Runtime safety:** CORS and exposure rules appropriate to environment.

## Worker prompt

```text
You are Team Platform/Edge in /Users/marwanelgendy/workspace/PP/gvp.
Work in docker-compose.yml, docker/nginx.conf, and docker/mock-contact.
Implement production-safe edge hardening (image pinning, health checks, and runtime restrictions) while preserving local developer flow.
Coordinate with Team Pipeline for CI and Team Production Readiness for sign-off.
```

## Definition of done

- [ ] Runtime architecture is documented for both local and production contexts.
- [ ] Edge hardening decisions are encoded in config (or explicitly deferred with rationale).
- [ ] Health/readiness checks align with actual service behavior.
- [ ] No regressions in local smoke workflow.
