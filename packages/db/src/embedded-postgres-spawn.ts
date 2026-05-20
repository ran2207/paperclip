import { existsSync } from "node:fs";
import path from "node:path";
import {
  ensureEmbeddedPostgresConnection,
  type MigrationConnection,
} from "./migration-runtime.js";

export interface EmbeddedPostgresHandle {
  url: string;
  release: () => Promise<void>;
}

/**
 * Open a short-lived connection to a local embedded Postgres data dir, intended
 * for tooling that needs a *side-connection* — e.g. the database setup wizard
 * importing data from a local instance while the running server points at an
 * external `DATABASE_URL`.
 *
 * Returns `null` when no embedded cluster has ever been initialized at
 * `dataDir` (no `PG_VERSION` file). Callers should render a "no local instance
 * found" affordance rather than throwing.
 *
 * If an embedded process is already running against this dataDir, the handle
 * adopts that connection and `release()` is a no-op. If the dataDir is
 * dormant, a fresh process is spawned and `release()` shuts it down.
 *
 * Callers must call `release()` in a finally block to avoid leaking processes.
 */
export async function openEmbeddedPostgresIfPresent(
  dataDir: string,
  preferredPort: number,
): Promise<EmbeddedPostgresHandle | null> {
  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) return null;
  const conn: MigrationConnection = await ensureEmbeddedPostgresConnection(
    dataDir,
    preferredPort,
  );
  return {
    url: conn.connectionString,
    release: conn.stop,
  };
}
