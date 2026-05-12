import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_COPILOT_COMMAND } from "../index.js";

async function readInstructionsFile(filePath: string): Promise<string> {
  if (!filePath) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function buildEnv(configEnv: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function toStringEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.agent.adapterConfig ?? ctx.config);
  const context = parseObject(ctx.context);

  const command = asString(config.command, DEFAULT_COPILOT_COMMAND);
  const promptArgFlag = asString(config.promptArgFlag, "-p");
  const extraArgs = asStringArray(config.extraArgs);
  const promptTemplate = asString(config.promptTemplate, "");
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  const timeoutSec = Math.max(0, asNumber(config.timeoutSec, 0));
  const graceSec = Math.max(1, asNumber(config.graceSec, 15));

  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(
    target,
    asString(config.cwd, ""),
    process.cwd(),
  );

  const env = toStringEnv(
    ensurePathInEnv({
      ...process.env,
      ...buildEnv(parseObject(config.env)),
    }),
  );

  const instructions = instructionsFilePath
    ? await readInstructionsFile(instructionsFilePath)
    : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: false,
  });
  const renderedTemplate = promptTemplate
    ? renderTemplate(promptTemplate, {
        agent: ctx.agent,
        runId: ctx.runId,
        context,
      })
    : "";
  const prompt = joinPromptSections([instructions, wakePrompt, renderedTemplate]);

  const args: string[] = [];
  if (promptArgFlag) args.push(promptArgFlag, prompt);
  else args.push(prompt);
  if (extraArgs.length > 0) args.push(...extraArgs);

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "copilot_local",
      command,
      cwd,
      commandArgs: args,
      env,
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructions.length,
        wakePromptChars: wakePrompt.length,
        templateChars: renderedTemplate.length,
      },
    });
  }

  const result = await runAdapterExecutionTargetProcess(
    ctx.runId,
    target,
    command,
    args,
    {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: async (stream, chunk) => {
        await ctx.onLog(stream, chunk);
      },
      onSpawn: ctx.onSpawn
        ? async (meta) => {
            await ctx.onSpawn?.({
              pid: meta.pid,
              processGroupId: meta.processGroupId ?? null,
              startedAt: meta.startedAt,
            });
          }
        : undefined,
    },
  );

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: "github",
    biller: "github",
    billingType: "subscription",
    summary: result.stdout.trim().slice(0, 2000) || null,
  };
}
