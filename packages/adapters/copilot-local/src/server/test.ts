import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_COPILOT_COMMAND } from "../index.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, DEFAULT_COPILOT_COMMAND);
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(
    target,
    asString(config.cwd, ""),
    process.cwd(),
  );
  const runId = `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const env: Record<string, string> = {};
  const configEnv = parseObject(config.env);
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(ensurePathInEnv({ ...process.env, ...env }))) {
    if (typeof value === "string") runtimeEnv[key] = value;
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install GitHub Copilot CLI and ensure `copilot` is on PATH. See https://docs.github.com/en/copilot/github-copilot-in-the-cli",
    });
  }

  const canRunProbe = checks.every(
    (check) =>
      check.code !== "copilot_cwd_invalid" &&
      check.code !== "copilot_command_unresolvable",
  );

  if (canRunProbe) {
    try {
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        ["--version"],
        {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      if ((probe.exitCode ?? 1) === 0) {
        const versionLine = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
        checks.push({
          code: "copilot_version_probe_passed",
          level: "info",
          message: "Copilot CLI responded to --version.",
          ...(versionLine ? { detail: versionLine.trim().slice(0, 240) } : {}),
        });
      } else {
        const detail = (probe.stderr || probe.stdout).split(/\r?\n/).find((line) => line.trim().length > 0);
        checks.push({
          code: "copilot_version_probe_failed",
          level: "warn",
          message: `Copilot CLI --version exited with code ${probe.exitCode ?? "?"}.`,
          ...(detail ? { detail: detail.trim().slice(0, 240) } : {}),
          hint: "Run `copilot --version` manually to inspect output.",
        });
      }
    } catch (err) {
      checks.push({
        code: "copilot_version_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Copilot --version probe errored.",
      });
    }
  }

  checks.push({
    code: "copilot_auth_note",
    level: "info",
    message: "Authentication uses `gh auth login` + an active Copilot subscription.",
    hint: "If runs fail with an auth error, run `gh auth login` and `gh auth status` to verify the active token has Copilot access.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
