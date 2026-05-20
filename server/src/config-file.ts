import fs from "node:fs";
import path from "node:path";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return paperclipConfigSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Persist the instance config back to disk. Validates against the schema
 * before writing so a malformed object can't corrupt the file. Written with
 * mode 0o600 — the file may hold a database connection string with a password.
 */
export function writeConfigFile(config: PaperclipConfig): void {
  const configPath = resolvePaperclipConfigPath();
  const validated = paperclipConfigSchema.parse(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + "\n", {
    mode: 0o600,
  });
}
