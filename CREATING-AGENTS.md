# Creating Agents in Paperclip

A practical guide to building agents in Paperclip — from the dashboard, from the
API, and from portable packages — and to bringing agents you already run in
Claude Code, GitHub Copilot, Cursor, or other tools into Paperclip.

> New to Paperclip itself? Start with the [README](README.md) for what Paperclip
> is and how to install it. This guide picks up once you have an instance running.

---

## Contents

- [What is an agent?](#what-is-an-agent)
- [Before you begin](#before-you-begin)
- [Three ways to create an agent](#three-ways-to-create-an-agent)
- [1. In the dashboard](#1-in-the-dashboard)
- [2. With the Paperclip API](#2-with-the-paperclip-api)
- [3. From a portable package](#3-from-a-portable-package)
- [Adapters reference](#adapters-reference)
- [Bringing agents from other tools](#bringing-agents-from-other-tools)
- [Skills](#skills)
- [Next steps](#next-steps)

---

## What is an agent?

In Paperclip, an **agent** is an AI employee. Every agent:

- is powered by an **adapter** — the runtime that actually runs the model
  (Claude Code, Codex, Gemini, Cursor, GitHub Copilot, and others);
- sits in a **company** under an **org chart**, reporting to a manager (the
  **CEO** is the root and the only agent that reports to the human board);
- does work as **issues** assigned to it, and wakes on events
  (**heartbeats**) — an assignment, a comment, a scheduled **routine**;
- can be given **skills** — reusable capability packages — and **secrets**
  such as API keys.

You don't script an agent step by step. You give it a role, a manager, a model,
and a goal, and it works the issues assigned to it.

---

## Before you begin

You need a running Paperclip instance and, for the API and CLI paths, the CLI.

```sh
# From the repo root — starts the API on http://localhost:3100 and the UI.
pnpm install
pnpm dev
```

The CLI ships in this repo and is invoked as `paperclipai` (or `pnpm paperclipai`
from the repo root).

```sh
# One-time: mint a board token via the device-code flow.
paperclipai auth login
paperclipai auth whoami        # confirm identity + active instance
```

In **local-trusted** mode (the default for `pnpm dev`) browser requests run as
the board with no sign-in. For the API recipes below, export two variables:

```sh
export PAPERCLIP_API_URL="http://localhost:3100/api"
export PAPERCLIP_API_KEY="$(paperclipai auth print-token)"
```

---

## Three ways to create an agent

| Method | Best for | You get |
|---|---|---|
| **Dashboard** | Your first agent; trying things out | Guided, visual, no setup |
| **API** | Automation, scripting, reproducible setups | Full control, no UI |
| **Portable package** | Versioned definitions, sharing, importing from other tools | Git-native files you can review and reuse |

All three create the same thing. Pick by how you like to work — and note that
the **portable package** is also how you bring in agents from outside Paperclip.

---

## 1. In the dashboard

Open the UI (`http://localhost:3100`). The first time, the **onboarding wizard**
walks you through creating a company and your first agent (the CEO).

To add more agents later, use **New Agent**. It offers two paths:

- **Let your CEO handle it** *(recommended)* — you describe the role you want
  filled; the CEO creates and configures the agent as a task. This keeps your
  org chart coherent and respects your company's hiring-approval policy.
- **Advanced** — you pick the adapter and configure the agent yourself.

Creating an agent directly asks for:

| Field | What it is |
|---|---|
| **Name** | The agent's display name (e.g. `CEO`, `Backend Engineer`) |
| **Role** | Its job — `ceo`, `cto`, `engineer`, `general`, etc. |
| **Adapter** | The runtime — see [Adapters reference](#adapters-reference) |
| **Model** | The model the adapter should use (adapter-specific) |
| **Reports to** | The manager this agent sits under in the org chart |

---

## 2. With the Paperclip API

Every dashboard action is a REST call, so you can create a whole company of
agents from a script — no UI. All requests need
`Authorization: Bearer $PAPERCLIP_API_KEY`; mutating requests also need
`Content-Type: application/json`.

### Step 1 — Create a company

```sh
curl -sX POST "$PAPERCLIP_API_URL/companies" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Acme Labs", "description": "Building the Acme product line." }' | jq .

# Capture the returned id:
export COMPANY_ID="<id from response>"
```

The response also includes an `issuePrefix` (used to format issue IDs like
`ACM-1`).

### Step 2 — Store the model API key as a secret

Create the secret your adapter will reference. Never inline plaintext keys into
adapter config.

```sh
curl -sX POST "$PAPERCLIP_API_URL/companies/$COMPANY_ID/secrets" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "ANTHROPIC_API_KEY", "value": "sk-ant-...", "description": "Claude key." }' | jq .

export ANTHROPIC_SECRET_ID="<id from response>"
```

The response carries only the secret `id` — the plaintext value is never echoed
back.

### Step 3 — Hire the CEO

The CEO is the root of the org chart and the only agent that reports to the
human board.

```sh
curl -sX POST "$PAPERCLIP_API_URL/companies/$COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CEO",
    "role": "ceo",
    "title": "Chief Executive",
    "capabilities": "Reads the company goal, sets strategy, delegates work.",
    "adapterType": "claude_local",
    "adapterConfig": {
      "model": "claude-sonnet-4-20250514",
      "cwd": "/path/to/your/repo",
      "env": {
        "ANTHROPIC_API_KEY": {
          "type": "secret_ref",
          "secretId": "'"$ANTHROPIC_SECRET_ID"'",
          "version": "latest"
        }
      }
    }
  }' | jq .

export CEO_AGENT_ID="<id from response>"
```

**`adapterConfig`** is adapter-specific. For a local CLI adapter it typically
holds the `model`, the working directory `cwd`, and an `env` map. Sensitive
values use a **`secret_ref`** pointing at a secret you created in step 2 —
`version: "latest"` automatically picks up rotations.

### Step 4 — Hire agents that report to the CEO

For any non-CEO agent, use the **hire route** so your company's hiring-approval
policy is respected.

```sh
curl -sX POST "$PAPERCLIP_API_URL/companies/$COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Backend Engineer",
    "role": "engineer",
    "reportsTo": "'"$CEO_AGENT_ID"'",
    "capabilities": "Owns the API service and its tests.",
    "adapterType": "claude_local",
    "adapterConfig": {
      "model": "claude-sonnet-4-20250514",
      "cwd": "/path/to/your/repo",
      "env": {
        "ANTHROPIC_API_KEY": {
          "type": "secret_ref",
          "secretId": "'"$ANTHROPIC_SECRET_ID"'",
          "version": "latest"
        }
      }
    }
  }' | jq .
```

Two possible responses:

- If the company requires board approval for new agents, you get a **pending
  approval** — approve it with
  `POST $PAPERCLIP_API_URL/approvals/<approvalId>/approve`.
- Otherwise you get the **agent object** directly.

### Putting it together

Steps 1–4 are a script: create the company, store the key, hire the CEO, then
loop step 4 for every report. Assigning an issue to an agent wakes it
automatically — no extra call needed.

> The full API surface (projects, issues, routines, heartbeats, approvals) is in
> the Paperclip docs: <https://paperclip.ing/docs>.

---

## 3. From a portable package

A **portable agent-company package** describes a company, its agents, projects,
tasks, and skills as plain Markdown files with YAML frontmatter. It follows the
**Agent Companies specification** (`agentcompanies/v1`) — a vendor-neutral,
Git-native format. The full spec lives at
[`docs/companies/companies-spec.md`](docs/companies/companies-spec.md).

Use a package when you want your agent definitions **version-controlled,
reviewable, and shareable** — and it's the format you adapt other tools' files
into (see the next section).

### Package layout

A package is a folder (or a Git repo). Each "kind" is identified by its primary
file:

```text
COMPANY.md                          # the company — metadata, goals, includes
agents/<slug>/AGENTS.md             # one agent
teams/<slug>/TEAM.md                # a team subtree
projects/<slug>/PROJECT.md          # a project
projects/<slug>/tasks/<slug>/TASK.md  # a task within a project
tasks/<slug>/TASK.md                # a standalone task
skills/<slug>/SKILL.md              # a reusable skill
.paperclip.yaml                     # optional Paperclip-specific extensions
assets/                             # images and other binary files
```

A repo can hold one package at its root or many packages in subdirectories.

### What each file carries

Every file is Markdown: **YAML frontmatter** for structured fields, and the
**body** for instructions written in prose.

```markdown
---
schema: agentcompanies/v1
kind: agent
name: Backend Engineer
title: Senior Backend Engineer
role: engineer
reportsTo: ceo
skills:
  - api-testing
  - postgres-migrations
capabilities: Owns the API service, its database, and its test suite.
---

You are the Backend Engineer. You keep the API service healthy and well-tested.

- Favor small, reviewed pull requests.
- Never merge with failing tests.
- Escalate schema changes to the CTO before applying them.
```

The **frontmatter** wires the agent into the org chart and attaches skills. The
**body** is the agent's standing instructions — its persona, priorities, and
rules. This is exactly where an existing `CLAUDE.md` or instruction file goes
(next section).

Key fields by file:

| File | Required | Common optional |
|---|---|---|
| `COMPANY.md` | `name`, `description`, `slug`, `schema` | `goals`, `includes`, `license`, `authors` |
| `AGENTS.md` | `name`, `title` | `role`, `reportsTo`, `skills`, `capabilities` |
| `PROJECT.md` | `name` | `description`, `owner`, `includes` |
| `TASK.md` | `name` | `assignee`, `project`, `priority`, `recurring` |
| `SKILL.md` | `name`, `description` | `allowed-tools`, `metadata` |

Identity in a package is the **slug and relative path**, not a database ID — so
packages stay portable across instances.

### Import a package into Paperclip

Use the CLI `company import` command. The source can be a local folder, a URL,
or a GitHub repo.

```sh
# From a local folder
paperclipai company import ./my-company --target new

# From a GitHub repo, pinned to a ref
paperclipai company import github:owner/repo/path/to/package --ref main --target new

# Preview only — see what would be created, change nothing
paperclipai company import ./my-company --dry-run
```

Useful options:

| Option | Purpose |
|---|---|
| `--target new \| existing` | Create a new company, or merge into an existing one |
| `-C, --company-id <id>` | The target company for `--target existing` |
| `--new-company-name <name>` | Name override when creating a new company |
| `--include company,agents,projects,issues,tasks,skills` | Import only certain kinds |
| `--agents <slugs>` | Import specific agents (default: `all`) |
| `--collision rename \| skip \| replace` | What to do when a name already exists |
| `--dry-run` | Preview without applying |

The same operation is available over the API at
`POST /api/companies/import` (and `/api/companies/import/preview`), which accepts
either an inline file bundle or a GitHub source.

To go the other way — turn a running company into a package — use
`paperclipai company export`.

---

## Adapters reference

The **adapter** decides which runtime executes an agent. Pick it per agent via
`adapterType` (API) or the adapter cards (UI).

| `adapterType` | Runs the agent on |
|---|---|
| `claude_local` | Claude Code, as a local process |
| `codex_local` | Codex CLI, as a local process |
| `gemini_local` | Gemini CLI, as a local process |
| `cursor` | Cursor |
| `cursor_cloud` | Cursor Cloud, via its API |
| `copilot_local` | GitHub Copilot CLI, as a local process |
| `opencode_local` | OpenCode, as a local process |
| `openclaw_gateway` | A managed runtime reached over a gateway |

Local adapters run the model's CLI on your machine and need that CLI installed
and authenticated (or an API key supplied as a `secret_ref`). The exact
`adapterConfig` shape varies by adapter — the dashboard's adapter cards and the
[Paperclip docs](https://paperclip.ing/docs) show the fields each one expects.

---

## Bringing agents from other tools

If you already run agents in **Claude Code**, **GitHub Copilot**, **Cursor**, or
a Codex-style setup, you don't start over. Those tools each keep their agent's
behavior in an instruction file, and Paperclip's package format has a direct
home for that content.

### Where your files map

| Tool | Your file | Goes into the package as |
|---|---|---|
| Claude Code | `CLAUDE.md` | The **body** of an `agents/<slug>/AGENTS.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | The **body** of an `agents/<slug>/AGENTS.md` |
| Cursor | `.cursor/rules/*.mdc` or `.cursorrules` | The **body** of an `agents/<slug>/AGENTS.md` |
| Codex / generic | `AGENTS.md` | The **body** of an `agents/<slug>/AGENTS.md` |
| Reusable prompt snippets / capabilities | scattered notes, prompt files | A `skills/<slug>/SKILL.md` package |
| Model / API key | tool config, env vars | A Paperclip **secret**, referenced via `secret_ref` |

The instruction file from any of these tools is, conceptually, the same thing:
**standing instructions for one agent.** In Paperclip that's the body of an
agent's `AGENTS.md`.

### How to do it

1. **Create a package folder.** Add a `COMPANY.md` at the root with the
   company name, description, and slug.

2. **Make one agent per instruction file.** For each `CLAUDE.md` /
   `copilot-instructions.md` / `.cursorrules` / `AGENTS.md` you have, create
   `agents/<slug>/AGENTS.md`. Put structured details (name, title, role, who it
   reports to) in the frontmatter, and **paste the instruction file's content
   as the body.**

3. **Turn reusable pieces into skills.** If your old setup had prompt snippets,
   playbooks, or capability files you reused across agents, make each one a
   `skills/<slug>/SKILL.md` and list it under the agent's `skills:` frontmatter.

4. **Choose an adapter per agent.** Set `adapterType` to the runtime you want —
   `claude_local`, `copilot_local`, `cursor`, etc. (see
   [Adapters reference](#adapters-reference)). This is independent of where the
   instructions came from: a `CLAUDE.md` can run under any adapter.

5. **Move keys into secrets.** Don't carry API keys in files. Create them as
   Paperclip secrets and reference them with `secret_ref` in `adapterConfig`.

6. **Import.** Run `paperclipai company import ./your-package --target new`
   (use `--dry-run` first to preview).

> There is no automatic one-click importer for `CLAUDE.md` or Copilot/Cursor
> rules — the adaptation above is a deliberate, reviewable step. The payoff is
> that once your agents are in package form they're portable across instances
> and easy to version and share.

---

## Skills

A **skill** is a reusable capability package — a `SKILL.md` with YAML
frontmatter and a Markdown body, following the Agent Skills specification. Skills
live at `skills/<slug>/SKILL.md` in a package.

Attach skills to an agent by listing them in the agent's frontmatter:

```yaml
skills:
  - api-testing
  - postgres-migrations
```

Skills are how you give several agents the same capability without copying
instructions into each one. Keep an agent's `AGENTS.md` body focused on *who the
agent is*; put *how to do a specific thing* into a skill.

---

## Next steps

- [README](README.md) — what Paperclip is, install, and run
- [`docs/companies/companies-spec.md`](docs/companies/companies-spec.md) — the
  full Agent Companies (`agentcompanies/v1`) specification
- [`doc/CLI.md`](doc/CLI.md) — the complete CLI reference
- [Paperclip docs](https://paperclip.ing/docs) — the full API and platform
  reference
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributing to Paperclip itself
