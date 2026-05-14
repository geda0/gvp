# Local secrets layout (example)

Copy this folder to **`.secrets/`** at the repo root (gitignored). **`deploy.env.example` is the single canonical list** of deploy-time variable names for both local SAM deploy and GitHub Actions secrets (same names, no `export` prefix in GitHub). Optional chat (Lambda SAM + Gemini, ECR/ECS) settings are in **`chat-deploy.env.example`** — copy to **`.secrets/chat-deploy.env`** if you use them; **`scripts/integrate-and-deploy.sh`** sources it after `deploy.env`.

```bash
cp -R secrets.example .secrets
cp secrets.example/deploy.env.example .secrets/deploy.env
chmod 600 .secrets/deploy.env .secrets/files/* 2>/dev/null || true
# Edit .secrets/deploy.env, and optionally manifest.json / config.manifest.json / .secrets/files/
```

Then run:

```bash
bash scripts/integrate-and-deploy.sh
```

That command **uploads** each entry in `manifest.json` to **AWS Secrets Manager** when both `manifest.json` and `config.manifest.json` exist (unless `SKIP_SECRETS_MANAGER=1`), writes **`.secrets/deploy.generated.env`** (exports ARNs for optional `exportAs` keys), **sources** `deploy.env` + generated env files, then runs **SAM build/deploy** and optional HTML sync.

It also seeds **non-secret config values** from `config.manifest.json` into **`.secrets/config.generated.env`**, then sources that file before deploy.

Manifest entries support optional **`"skipIfEmpty": true`** (skip create/put when the file is missing or zero-length).

`config.manifest.json` format (often empty `configs` unless you need extra non-secret exports):

```json
{
  "version": 1,
  "configs": []
}
```

Add `configs` entries when you need non-secret values exported before deploy (see `scripts/seed_local_configs.py`).
