---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Azure Web App

This repo includes an additional GitHub Actions workflow for Azure Web App deployment:

- `.github/workflows/azure-webapp.yml` manually builds Paperclip, creates a portable Node deployment bundle for a standard Azure Web App, and also builds/pushes a Docker image to `azacrlmsnp.azurecr.io`

Required GitHub configuration:

- Repository variable: `AZURE_WEBAPP_NAME`
- Repository secret: `AZURE_DEPLOYMENT_PROFILE` (the publish profile downloaded from the Web App)
- Repository secrets for ACR push: `ACR_USERNAME`, `ACR_PASSWORD`

Notes:

- The workflow deploys a built package to App Service, so the Web App does not need to be configured as a custom-container app.
- The workflow sets the startup command to run Paperclip with `HOST=0.0.0.0`, `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, and `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`.
- You still need normal runtime app settings in Azure for your deployment, such as `BETTER_AUTH_SECRET`, database settings, API keys, and optionally `PAPERCLIP_PUBLIC_URL` if you use a custom domain.

## Data Persistence

All data is persisted under the bind mount (`./data/docker-paperclip`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Claude and Codex Adapters in Docker

The Docker image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
