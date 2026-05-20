import { Router, type Request, type Response } from "express";
import { existsSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sql as drizzleSql } from "drizzle-orm";
import {
  applyPendingMigrations,
  inspectMigrations,
  openDb,
  companies as companiesTable,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyPortabilityService } from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { logger } from "../middleware/logger.js";
import { readConfigFile, writeConfigFile } from "../config-file.js";
import { assertBoardOrgAccess, getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

const SELECTION_KEYS = [
  "companies",
  "agents",
  "companySecrets",
  "projects",
  "goals",
  "issues",
  "routines",
] as const;

const localExportSelectionSchema = z.object({
  selection: z.object(
    Object.fromEntries(SELECTION_KEYS.map((k) => [k, z.boolean()])) as Record<
      (typeof SELECTION_KEYS)[number],
      z.ZodBoolean
    >,
  ),
  /**
   * Defaults to true. When true, the destination preserves source UUIDs and
   * issue identifiers so external links (`/{prefix}/issues/ACM-42`) survive.
   * Surface to the user as a single "Keep URLs working" toggle on the wizard.
   */
  preserveIds: z.boolean().optional().default(true),
});

const localExportValidateSchema = z.object({
  preserveIds: z.boolean().optional().default(true),
});

const connectionStringField = z
  .string()
  .min(1)
  .refine(
    (s) => /^postgres(ql)?:\/\//.test(s.trim()),
    "Connection string must start with postgres:// or postgresql://",
  );

const databaseConnectionSchema = z.object({
  connectionString: connectionStringField,
});

/**
 * Reject a promise that runs longer than `ms`. Used to bound connection
 * probes — a wrong host behind a packet-dropping firewall can otherwise hang
 * the request well past any sane timeout.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * True when the server is running under the dev supervisor (`pnpm dev` →
 * dev-runner → `tsx watch`). The dev-runner sets PAPERCLIP_DEV_SERVER_STATUS_FILE
 * on the spawned process; its presence means a file-watcher is live and will
 * restart the process on a source change.
 */
function isUnderDevWatcher(): boolean {
  return Boolean(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE?.trim());
}

/**
 * Ask the dev file-watcher to restart the server by bumping the mtime of the
 * entry module. `tsx watch` (see server/scripts/dev-watch.ts) watches
 * src/index.ts and restarts on any change event — a pure mtime touch counts,
 * with no content mutation. This is the only programmatic restart hook the
 * codebase exposes: the dev-runner has no restart endpoint or signal.
 *
 * Returns false (and does nothing) outside a watcher — e.g. production, where
 * a restart instead comes from the container/process supervisor. The wizard
 * falls back to the manual restart handoff in that case.
 */
function triggerDevServerRestart(): boolean {
  if (!isUnderDevWatcher()) return false;
  try {
    // routes/instance-database.ts → ../index.ts is the watched entry module.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(here, "../index.ts");
    if (!existsSync(entry)) return false;
    const now = new Date();
    utimesSync(entry, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared tail for the connection-mutating endpoints. When under a dev watcher,
 * schedules the restart for *after* the response has flushed — the watcher
 * SIGTERMs this process within milliseconds of the entry-module touch, so the
 * client must receive its response first.
 */
function scheduleAutoRestart(res: Response, autoRestart: boolean): void {
  if (!autoRestart) return;
  res.on("finish", () => {
    setTimeout(() => triggerDevServerRestart(), 150);
  });
}

/**
 * Turn a connection failure into a safe, generic message. NEVER returns the
 * raw error text — postgres.js errors can echo the connection string, which
 * carries the password. We surface only the error code when it's a recognised
 * one, plus a fixed remediation hint.
 */
function describeConnectionFailure(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : null;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Host not found — check the hostname in the connection string.";
    case "ECONNREFUSED":
      return "Connection refused — check the port and that the database accepts connections.";
    case "28P01":
      return "Authentication failed — check the username and password.";
    case "3D000":
      return "Database does not exist — check the database name.";
    default:
      return "Could not connect. Verify the host, port, database name, credentials, and SSL mode.";
  }
}

export interface ValidationIssue {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface InstanceDatabaseDeps {
  db: Db;
  config: {
    databaseMode: "embedded-postgres" | "postgres";
    databaseUrl: string | undefined;
  };
  /**
   * Returns a connection string to the *local embedded* Postgres for this host,
   * spinning it up if needed. Returns null when no embedded data dir exists.
   * Caller is responsible for calling release() when done.
   */
  openLocalEmbeddedConnection: () => Promise<
    { url: string; release: () => Promise<void> } | null
  >;
  /**
   * Destination storage service — needed by copyEntitiesViaPortability() so
   * imported company logos and issue attachments land in object storage.
   */
  storage?: StorageService;
}

export function instanceDatabaseRoutes(deps: InstanceDatabaseDeps) {
  const router = Router();
  const { db, config } = deps;

  // Single-instance mutex covering the long-running mutations (apply + migrate).
  // Paperclip's deployment is one Node process per instance, so an in-memory
  // flag is sufficient. Two concurrent applies against the same destination
  // would race on `applyPendingMigrations` and `importBundle`, leaving partial
  // state; second caller gets 409 and is expected to retry once the first
  // finishes. Released in finally; survives thrown errors. Not held for the
  // read endpoints (status, preview, validate) which are safe to interleave.
  let mutationInFlight = false;
  function acquireMutationLock(): boolean {
    if (mutationInFlight) return false;
    mutationInFlight = true;
    return true;
  }
  function releaseMutationLock(): void {
    mutationInFlight = false;
  }

  router.get("/instance/database/status", async (req, res) => {
    assertBoardOrgAccess(req);
    const url = config.databaseUrl;
    if (!url) {
      res.json({
        mode: config.databaseMode,
        host: null,
        database: null,
        reachable: false,
        schemaPresent: false,
        appliedMigrations: [],
        pendingMigrations: [],
        tables: [],
      });
      return;
    }

    const { host, database } = parsePostgresUrl(url);

    try {
      const state = await inspectMigrations(url);
      const tables = await listTableRowCounts(url);
      res.json({
        mode: config.databaseMode,
        host,
        database,
        reachable: true,
        schemaPresent: state.tableCount > 0,
        appliedMigrations: state.appliedMigrations,
        pendingMigrations:
          state.status === "upToDate" ? [] : state.pendingMigrations,
        tables,
      });
    } catch {
      res.json({
        mode: config.databaseMode,
        host,
        database,
        reachable: false,
        schemaPresent: false,
        appliedMigrations: [],
        pendingMigrations: [],
        tables: [],
      });
    }
  });

  router.post("/instance/database/migrate", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const url = config.databaseUrl;
    if (!url) throw notFound("No database connection configured");

    if (!acquireMutationLock()) {
      throw conflict("Another database mutation is already running. Wait for it to finish, then retry.");
    }
    try {
      const before = await inspectMigrations(url);
      const beforeApplied = new Set(before.appliedMigrations);

      await applyPendingMigrations(url);

      const after = await inspectMigrations(url);
      const applied = after.appliedMigrations.filter((m) => !beforeApplied.has(m));

      // Audit: instance-level events don't fit activity_log (which requires
      // companyId). Structured logger with a stable `event` key is the
      // practical channel — greppable, picked up by any log aggregator.
      const actor = getActorInfo(req);
      logger.info(
        {
          event: "instance.database.migrated",
          actorType: actor.actorType,
          actorId: actor.actorId,
          appliedCount: applied.length,
          applied,
        },
        "Instance database migrated",
      );

      res.json({ applied });
    } finally {
      releaseMutationLock();
    }
  });

  router.post(
    "/instance/database/test-connection",
    validate(databaseConnectionSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const { connectionString } = req.body as z.infer<typeof databaseConnectionSchema>;
      // Read-only probe: inspectMigrations opens its own connection, runs a
      // schema query, and closes. It doubles as a reachability check (throws
      // on a bad host/credentials) and a schema-state check.
      try {
        const state = await withTimeout(
          inspectMigrations(connectionString.trim()),
          10_000,
          "connection probe",
        );
        res.json({
          reachable: true,
          schemaPresent: state.tableCount > 0,
          pendingMigrations:
            state.status === "upToDate" ? [] : state.pendingMigrations,
        });
      } catch (err) {
        res.json({
          reachable: false,
          schemaPresent: false,
          pendingMigrations: [],
          error: describeConnectionFailure(err),
        });
      }
    },
  );

  router.post(
    "/instance/database/connection",
    validate(databaseConnectionSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const { connectionString } = req.body as z.infer<typeof databaseConnectionSchema>;
      const trimmed = connectionString.trim();

      // The env var wins over the config file (see config.ts). Persisting to
      // config.json would be silently ignored on the next boot, so refuse.
      if (process.env.DATABASE_URL) {
        throw unprocessable(
          "DATABASE_URL is set in the environment, which overrides the config file. " +
            "Change or unset that environment variable to manage the connection from here.",
        );
      }

      // Validate before persisting — never write a connection we can't reach.
      try {
        await withTimeout(inspectMigrations(trimmed), 10_000, "connection probe");
      } catch (err) {
        throw unprocessable(describeConnectionFailure(err));
      }

      const current = readConfigFile();
      if (!current) {
        throw notFound(
          "No instance config file found to update — this instance is environment-driven.",
        );
      }
      writeConfigFile({
        ...current,
        database: {
          ...current.database,
          mode: "postgres",
          connectionString: trimmed,
        },
      });

      const actor = getActorInfo(req);
      const autoRestart = isUnderDevWatcher();
      logger.info(
        {
          event: "instance.database.connection_changed",
          actorType: actor.actorType,
          actorId: actor.actorId,
          autoRestart,
          // The connection string is NOT logged — it carries a password.
        },
        "Instance database connection string updated; restart required",
      );

      scheduleAutoRestart(res, autoRestart);
      res.json({ persisted: true, restartRequired: true, autoRestart });
    },
  );

  router.post("/instance/database/use-embedded", async (req, res) => {
    assertCanManageInstanceSettings(req);

    if (process.env.DATABASE_URL) {
      throw unprocessable(
        "DATABASE_URL is set in the environment, which overrides the config file. " +
          "Unset that environment variable to fall back to the embedded database.",
      );
    }

    const current = readConfigFile();
    if (!current) {
      throw notFound(
        "No instance config file found to update — this instance is environment-driven.",
      );
    }
    if (current.database.mode === "embedded-postgres") {
      throw unprocessable("Already using the embedded database.");
    }
    // Flip the mode only. The connectionString is left in place — config.ts
    // ignores it while mode is embedded-postgres, and keeping it lets the
    // operator switch back to the same external database in one click later.
    writeConfigFile({
      ...current,
      database: { ...current.database, mode: "embedded-postgres" },
    });

    const actor = getActorInfo(req);
    const autoRestart = isUnderDevWatcher();
    logger.info(
      {
        event: "instance.database.reverted_to_embedded",
        actorType: actor.actorType,
        actorId: actor.actorId,
        autoRestart,
      },
      "Instance database reverted to embedded Postgres; restart required",
    );

    scheduleAutoRestart(res, autoRestart);
    res.json({ persisted: true, restartRequired: true, autoRestart });
  });

  router.get("/instance/database/local-export/preview", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const handle = await deps.openLocalEmbeddedConnection();
    if (!handle) {
      res.json({
        reachable: false,
        source: { mode: "embedded-postgres", host: null, database: null },
        counts: zeroCounts(),
      });
      return;
    }
    try {
      const { host, database } = parsePostgresUrl(handle.url);
      const counts = await countEntities(handle.url);
      res.json({
        reachable: true,
        source: { mode: "embedded-postgres", host, database },
        counts,
      });
    } finally {
      await handle.release();
    }
  });

  router.post(
    "/instance/database/local-export/validate",
    validate(localExportValidateSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);

      // Validation is preserveIds-sensitive: prefix collisions only matter when
      // we'd try to insert with the source's prefix. Schema defaults preserveIds
      // to true so missing-field bodies are treated as "the wizard's primary
      // mode" rather than silently falling into the alternate path.
      const { preserveIds } = req.body as z.infer<typeof localExportValidateSchema>;

    const handle = await deps.openLocalEmbeddedConnection();
    if (!handle) {
      res.json({ errors: [], warnings: [] });
      return;
    }

    try {
      const { db: sourceDb, close: closeSource } = openDb(handle.url);
      try {
        const sourceCompanies = await sourceDb
          .select({
            id: companiesTable.id,
            name: companiesTable.name,
            issuePrefix: companiesTable.issuePrefix,
          })
          .from(companiesTable);
        const destCompanies = await db
          .select({
            id: companiesTable.id,
            name: companiesTable.name,
            issuePrefix: companiesTable.issuePrefix,
          })
          .from(companiesTable);

        const errors: ValidationIssue[] = [];
        const warnings: ValidationIssue[] = [];

        if (preserveIds) {
          const destByPrefix = new Map(
            destCompanies.map((c) => [c.issuePrefix, c]),
          );
          for (const src of sourceCompanies) {
            const collision = destByPrefix.get(src.issuePrefix);
            if (!collision) continue;
            if (collision.id === src.id) {
              warnings.push({
                code: "issue_prefix_idempotent",
                message: `Company "${src.name}" already exists at the destination — it will be skipped.`,
                detail: { sourceCompanyId: src.id, issuePrefix: src.issuePrefix },
              });
            } else {
              errors.push({
                code: "issue_prefix_collision",
                message: `Issue prefix "${src.issuePrefix}" is already used by destination company "${collision.name}". Source company "${src.name}" cannot be imported with URL preservation on — issue identifiers would collide.`,
                detail: {
                  sourceCompanyId: src.id,
                  sourceCompanyName: src.name,
                  destCompanyId: collision.id,
                  destCompanyName: collision.name,
                  issuePrefix: src.issuePrefix,
                },
              });
            }
          }
        }

        if (sourceCompanies.length === 0) {
          warnings.push({
            code: "empty_source",
            message: "Source database has no companies — nothing will be imported.",
          });
        }

        // Destination-not-empty: applies regardless of preserveIds. Layering
        // a source onto a destination that already has unrelated companies
        // isn't a hard error — the user may genuinely want to merge — but
        // it's almost always a surprise during a "set up a new database"
        // flow, so we surface it loudly. Exclude pure idempotent retries
        // (every dest company id is also a source company id) to avoid
        // noise on the wizard's expected re-run path.
        if (destCompanies.length > 0) {
          const sourceIds = new Set(sourceCompanies.map((c) => c.id));
          const unrelated = destCompanies.filter((c) => !sourceIds.has(c.id));
          if (unrelated.length > 0) {
            warnings.push({
              code: "destination_not_empty",
              message: `Destination already has ${unrelated.length} compan${unrelated.length === 1 ? "y" : "ies"} not present in the source (${unrelated
                .slice(0, 3)
                .map((c) => `"${c.name}"`)
                .join(", ")}${unrelated.length > 3 ? `, +${unrelated.length - 3} more` : ""}). Importing will layer source data alongside the existing rows — verify this is what you want.`,
              detail: {
                unrelatedCompanyCount: unrelated.length,
                sampleNames: unrelated.slice(0, 5).map((c) => c.name),
              },
            });
          }
        }

        res.json({ errors, warnings });
      } finally {
        await closeSource();
      }
    } finally {
      await handle.release();
    }
    },
  );

  router.post(
    "/instance/database/local-export/apply",
    validate(localExportSelectionSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const body = req.body as z.infer<typeof localExportSelectionSchema>;
      const { selection, preserveIds } = body;
      if (!selection.companies) {
        throw unprocessable("Companies must be selected — child entities have FK dependencies on companies.");
      }
      if (!deps.storage) {
        throw unprocessable("Destination storage is required to import logos and attachments.");
      }

      if (!acquireMutationLock()) {
        throw conflict("Another database mutation is already running. Wait for it to finish, then retry.");
      }

      const handle = await deps.openLocalEmbeddedConnection();
      if (!handle) {
        releaseMutationLock();
        throw notFound("No local embedded database found");
      }

      try {
        // Map the wizard's per-entity selection onto the portability include
        // mask. Secrets, goals and routines ride along with their parents and
        // are not independently selectable in this version.
        const result = await copyEntitiesViaPortability({
          sourceUrl: handle.url,
          db,
          storage: deps.storage,
          companyIds: [],
          include: {
            company: true,
            agents: selection.agents,
            projects: selection.projects,
            issues: selection.issues,
          },
          preserveIds,
        });

        const actor = getActorInfo(req);
        logger.info(
          {
            event: "instance.database.local_export_applied",
            actorType: actor.actorType,
            actorId: actor.actorId,
            preserveIds,
            include: {
              agents: selection.agents,
              projects: selection.projects,
              issues: selection.issues,
            },
            imported: {
              companies: result.companies.created,
              agents: result.agents.created,
            },
            skipped: {
              companies: result.companies.skipped,
              agents: result.agents.skipped,
            },
            failed: {
              companies: result.companies.failed,
              sample: result.failures.slice(0, 5).map((f) => ({
                sourceCompanyId: f.sourceCompanyId,
                sourceCompanyName: f.sourceCompanyName,
                message: f.message,
              })),
            },
            warningCount: result.warnings.length,
          },
          "Instance database local export applied",
        );

        res.json({
          imported: { companies: result.companies.created, agents: result.agents.created },
          skipped: { companies: result.companies.skipped, agents: result.agents.skipped },
          failed: {
            companies: result.companies.failed,
            details: result.failures,
          },
          warnings: result.warnings,
        });
      } finally {
        await handle.release();
        releaseMutationLock();
      }
    },
  );

  return router;
}

/**
 * Alternative to copyEntities(): pipe per-company portability bundles from
 * source → destination in-memory. Reuses ~4k lines of existing bundle logic
 * (secret re-encryption, agent rehire flow, FK ordering, conflict detection).
 *
 * Trade-offs versus the per-entity insertIfMissing path:
 *  - PRO: secrets, agents, projects, issues, skills all handled in one call.
 *  - PRO: storage assets (logos, attachments) are written through the storage
 *         service rather than skipped.
 *  - CON: destination companies get FRESH UUIDs — source ids do not survive.
 *         Same for agents/projects/issues. External references (bookmarks,
 *         agent JWT subject claims, etc.) break.
 *  - CON: the wizard's per-entity selection collapses to "which companies",
 *         with a per-company include mask of company/agents/projects/issues.
 *         `routines` and `companySecrets` ride along with their parent agents
 *         and are not independently selectable.
 *  - CON: needs a destination StorageService; per-entity path does not.
 */
export interface CopyViaPortabilityArgs {
  sourceUrl: string;
  db: Db;
  storage: StorageService;
  /** Subset of source company ids to import. Empty = import every source company. */
  companyIds: string[];
  include: { company: boolean; agents: boolean; projects: boolean; issues: boolean };
  /**
   * When true, preserve source UUIDs and issue identifiers so bookmarked URLs
   * keep resolving after the migration. When false, the destination mints
   * fresh ids and `ACM-42`-style links break.
   */
  preserveIds: boolean;
}

export async function copyEntitiesViaPortability(args: CopyViaPortabilityArgs) {
  const { db: sourceDb, close: closeSource } = openDb(args.sourceUrl);

  // Two portability service instances — one bound to each database. The source
  // instance has no storage (we don't need to write into source storage during
  // export; logos are read via sourceStorage inside exportBundle if provided,
  // and skipped with a warning otherwise).
  const sourcePortability = companyPortabilityService(sourceDb);
  const destPortability = companyPortabilityService(args.db, args.storage);

  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const agentCounts = { created: 0, updated: 0, skipped: 0 };
  const warnings: string[] = [];
  const failures: { sourceCompanyId: string; sourceCompanyName: string; message: string }[] = [];

  try {
    const allCompanies = await sourceDb
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(companiesTable);

    const targetIds = args.companyIds.length > 0
      ? new Set(args.companyIds)
      : new Set(allCompanies.map((c) => c.id));

    // Per-company error isolation: an export or import throwing for one company
    // must not abort the entire pipeline — already-imported companies stay
    // committed (no destination-side transaction wraps the loop), so aborting
    // would leave partial state with no resume affordance. Instead, record the
    // failure as a structured warning + a failed counter, and continue. The
    // user retries the wizard to re-attempt failed companies; successful ones
    // are idempotent via insertIfMissing skips.
    for (const source of allCompanies) {
      if (!targetIds.has(source.id)) continue;

      try {
        const bundle = await sourcePortability.exportBundle(source.id, {
          include: args.include,
        });
        warnings.push(...bundle.warnings.map((w) => `[export ${source.name}] ${w}`));

        const result = await destPortability.importBundle(
          {
            source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
            include: args.include,
            target: { mode: "new_company", newCompanyName: source.name },
            // With preserveIds: skip on collision so we don't double-import.
            // Without: rename to disambiguate from any prior import with the same name.
            collisionStrategy: args.preserveIds ? "skip" : "rename",
          },
          /* actorUserId */ null,
          { preserveIds: args.preserveIds },
        );

        if (result.company.action === "created") counts.created++;
        else if (result.company.action === "updated") counts.updated++;
        else counts.skipped++;

        for (const agent of result.agents) {
          if (agent.action === "created") agentCounts.created++;
          else if (agent.action === "updated") agentCounts.updated++;
          else agentCounts.skipped++;
        }

        warnings.push(...result.warnings.map((w) => `[import ${source.name}] ${w}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        counts.failed++;
        failures.push({
          sourceCompanyId: source.id,
          sourceCompanyName: source.name,
          message,
        });
        warnings.push(`[failed ${source.name}] ${message}`);
      }
    }
  } finally {
    await closeSource();
  }

  return {
    companies: counts,
    agents: agentCounts,
    warnings,
    failures,
  };
}

function parsePostgresUrl(url: string): { host: string | null; database: string | null } {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || null;
    const host = parsed.hostname || null;
    return { host, database };
  } catch {
    return { host: null, database: null };
  }
}

async function listTableRowCounts(url: string): Promise<{ name: string; rowCount: number }[]> {
  const { db, close } = openDb(url);
  try {
    const result = await db.execute<{ relname: string; n_live_tup: number | string }>(
      drizzleSql`
        SELECT relname, n_live_tup
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
        ORDER BY relname
      `,
    );
    return result.map((row) => ({ name: row.relname, rowCount: Number(row.n_live_tup) }));
  } finally {
    await close();
  }
}

function zeroCounts() {
  return Object.fromEntries(SELECTION_KEYS.map((k) => [k, 0])) as Record<
    (typeof SELECTION_KEYS)[number],
    number
  >;
}

const TABLE_FOR_KEY: Record<(typeof SELECTION_KEYS)[number], string> = {
  companies: "companies",
  agents: "agents",
  companySecrets: "company_secrets",
  projects: "projects",
  goals: "goals",
  issues: "issues",
  routines: "routines",
};

async function countEntities(url: string) {
  const { db, close } = openDb(url);
  try {
    const counts = zeroCounts();
    for (const key of SELECTION_KEYS) {
      const table = TABLE_FOR_KEY[key];
      const result = await db.execute<{ c: string }>(
        drizzleSql`SELECT count(*)::text AS c FROM ${drizzleSql.identifier(table)}`,
      );
      counts[key] = Number(result[0]?.c ?? 0);
    }
    return counts;
  } finally {
    await close();
  }
}

