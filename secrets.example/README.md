# Local secrets layout (example)

Copy this folder to **`.secrets/`** at the repo root (gitignored):

```bash
cp -R secrets.example .secrets
chmod 600 .secrets/deploy.env .secrets/files/*
# edit .secrets/manifest.json, .secrets/config.manifest.json, .secrets/deploy.env, and add files under .secrets/files/
```

Then run:

```bash
bash scripts/orchestrate-deploy.sh
```

That command **uploads** each entry in `manifest.json` to **AWS Secrets Manager**, writes **`.secrets/deploy.generated.env`** (exports ARNs for optional `exportAs` keys), **sources** `deploy.env` + `deploy.generated.env`, and runs **`scripts/integrate-and-deploy.sh`** (SAM build/deploy and optional HTML sync).

It also seeds **non-secret config values** from `config.manifest.json` into **`.secrets/config.generated.env`**, then sources that file before deploy.

If you use `exportAs` for the BigQuery service account, **omit** `GCP_SERVICE_ACCOUNT_JSON` from `deploy.env` so the deploy step does not push the JSON a second time (the ARN from `deploy.generated.env` is enough).

Manifest entries support optional **`"skipIfEmpty": true`** (skip create/put when the file is missing or zero-length).

Config manifest format:

```json
{
  "version": 1,
  "configs": [
    { "name": "TRAFFIC_GCP_PROJECT_ID", "value": "homepage-496107", "required": true }
  ]
}
```
