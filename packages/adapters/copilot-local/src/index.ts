export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";

export const DEFAULT_COPILOT_COMMAND = "copilot";

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local (minimal scaffold)

Use when:
- You want Paperclip to run the GitHub Copilot CLI locally on the host machine
- The host has \`copilot\` installed and authenticated via \`gh auth login\` with an active Copilot subscription

Don't use when:
- Copilot CLI is not installed on the host
- You need session resume / tool-streaming parity with Claude Code or Codex (not yet implemented for this adapter)

Core fields:
- cwd (string, optional): default absolute working directory for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- command (string, optional): defaults to "copilot"
- promptArgFlag (string, optional): the CLI flag used to pass the prompt. Defaults to "-p". Common alternatives: "--prompt", "" (positional).
- extraArgs (string[], optional): additional CLI args appended after the prompt
- env (object, optional): KEY=VALUE environment variables passed to the process
- promptTemplate (string, optional): run prompt template

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds (default 15)

Notes:
- This is a minimal-fidelity adapter. stdout is captured verbatim; rich
  event parsing (tool calls, token usage, session resume) is not yet
  implemented. Once you've confirmed the basic spawn loop works,
  expand parse.ts to decode the CLI's actual event stream.
- Authentication: requires \`gh auth login\` and an active GitHub Copilot
  subscription on the host. No API key configuration is exposed.
`;
