import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line) return [];
  return [{ kind: "stdout", ts, text: line }];
}
