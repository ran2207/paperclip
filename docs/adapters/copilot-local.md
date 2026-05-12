---
title: Copilot Local
description: Run GitHub Copilot CLI locally as a Paperclip agent (minimal scaffold).
---

# Copilot Local (`copilot_local`)

Spawns the [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (`copilot` binary) on the Paperclip host. Authentication piggybacks on `gh auth login` — the host must have an active Copilot subscription.

> **Status: minimal scaffold.** This adapter is a thin wrapper around the
> `copilot` binary. stdout is captured verbatim; rich event parsing (tool
> calls, usage, cost, session resume) is not yet implemented. Expand
> `packages/adapters/copilot-local/src/server/execute.ts` and add a real
> `parse.ts` once you've inspected actual Copilot CLI output.

## Requirements

- `copilot` CLI installed and on PATH (`which copilot`)
- `gh auth login` completed with an account that has a GitHub Copilot subscription
- Test with: `copilot --version`

## Config

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | string | `copilot` | Override if the binary isn't on PATH |
| `promptArgFlag` | string | `-p` | CLI flag used to pass the prompt. Try `--prompt` or `""` (positional) if `-p` isn't recognized. |
| `extraArgs` | string[] | `[]` | Appended after the prompt |
| `cwd` | string | (agent default) | Absolute working directory |
| `instructionsFilePath` | string | — | Path to a markdown file prepended to every prompt |
| `env` | object | `{}` | Extra environment variables |
| `timeoutSec` | number | `0` | Run timeout in seconds (0 = no timeout) |
| `graceSec` | number | `15` | SIGTERM grace period before SIGKILL |

## Limitations

- No session resume — every run starts a fresh Copilot session.
- No model picker — Copilot CLI does not expose model selection.
- No skills sync — Paperclip skills are not yet injected into Copilot's config dir.
- No cost/usage tracking — the `usage` field of execution results is unset.

These can be added by extending the adapter's `server/` files. Use the
existing `gemini-local` or `claude-local` adapter packages as references.
