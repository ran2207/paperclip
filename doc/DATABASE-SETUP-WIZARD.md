# Database Setup Wizard

A four-step UI flow that handles three operator scenarios:

1. **First-run setup** — fresh remote database needs the Paperclip schema applied.
2. **Switching databases** — operator pointed `DATABASE_URL` at a new destination and wants to migrate their existing local data over.
3. **Resuming an aborted migration** — earlier import failed partway; rerun to pick up the remainder.

It is designed around a single load-bearing promise: **after migrating, your bookmarked Paperclip URLs keep working**. Company IDs, agent IDs, project IDs, and issue identifiers (`ACM-42`) are preserved verbatim across the migration.

---

## User-facing flow

Steps render inside a centered modal (`ui/src/components/DatabaseSetupWizard.tsx`):

| Step | Component path | What it does |
|---|---|---|
| 1. Connection | `ConnectionStep` | Probes `GET /instance/database/status`. Shows mode (embedded vs external), host, reachability, schema-present flag, pending migration count, table count. |
| 2. Schema | `SchemaStep` | Lists pending migrations from `inspectMigrations()`. "Apply migrations" button runs `POST /instance/database/migrate`. Skipped if schema is already up-to-date. |
| 3. Import | `ImportStep` | Optional. Fires `GET /instance/database/local-export/preview` for per-entity counts and `POST /instance/database/local-export/validate` for pre-flight collision checks. User toggles "Keep URLs working" (preserveIds) and chooses which entity types to import. Apply button is gated on validation errors. |
| 4. Done | `DoneStep` | Summarizes imported/skipped/failed counts. Surfaces per-company failures via `FailureList` and informational warnings via `WarningList`. |

### Entry points

Two ways the wizard opens:

- **Auto-opener** (`DatabaseSetupAutoOpener.tsx`) — headless component mounted at the App root. Fires once per session in `local_trusted` deployment mode when the destination DB is reachable but `schemaPresent === false`. Authenticated mode is excluded (we can't tell client-side whether the user is instance-admin).
- **Settings → General → Database** — `InstanceGeneralSettings.tsx` renders a section with the current connection summary, a status pill (`ready`/`unreachable`/`schema not initialized`/`N pending migrations`), and a "Change database" button that calls `openDatabaseSetup()` on the dialog context.

State is managed via `useDialog().databaseSetupOpen` (see `ui/src/context/DialogContext.tsx`).

---

## Architecture

### Server side

```
server/src/routes/instance-database.ts          ← five endpoints + apply pipeline
server/src/services/company-portability.ts      ← bundle export/import with preserveIds branches
packages/db/src/embedded-postgres-spawn.ts      ← side-connection to local embedded PG
packages/db/src/migration-runtime.ts            ← shared embedded-PG lifecycle helper
```

#### Endpoints

All routes live under `/api/instance/database/...` and gate via `assertCanManageInstanceSettings` (except status which uses `assertBoardOrgAccess`).

| Method + path | Purpose | Mutex |
|---|---|---|
| `GET /status` | Current connection + reachability + schema state + per-table row counts | – |
| `POST /migrate` | Apply pending migrations against the active DB | ✓ |
| `GET /local-export/preview` | Per-entity counts in the local embedded source DB | – |
| `POST /local-export/validate` | Pre-flight checks (prefix collisions, destination-not-empty, empty-source) | – |
| `POST /local-export/apply` | Run the full source→destination portability pipeline | ✓ |

The mutex is an in-memory boolean on the route factory's closure. Sufficient for Paperclip's one-process-per-instance model. Second concurrent caller gets `409 Conflict`.

#### Dependency injection

`instanceDatabaseRoutes(deps)` takes:

```ts
interface InstanceDatabaseDeps {
  db: Db;                                  // destination Drizzle handle
  config: { databaseMode, databaseUrl };   // for status + migrate
  openLocalEmbeddedConnection: () => Promise<{ url, release } | null>;
  storage?: StorageService;                // for logo/attachment imports
}
```

`server/src/app.ts` wires these from the resolved server config. `openLocalEmbeddedConnection` defers to `openEmbeddedPostgresIfPresent` from `@paperclipai/db` — returns `null` when running in embedded mode (you ARE the local instance) or when no `PG_VERSION` file exists at the data dir.

---

## The preserveIds pipeline

This is the load-bearing innovation. When `preserveIds: true`, source UUIDs survive the migration; when `false`, the destination mints fresh ones.

### Pipeline

```
source DB                                           destination DB
   │                                                       │
   │  sourcePortability.exportBundle(companyId)            │
   │  ──────────► { files: Record<path, bytes>, manifest }─►
   │                                                       │
   │              destPortability.importBundle(bundle,     │
   │              { preserveIds: true })                   │
   │                                                       │
   │                              ┌───────────────────────►│
   │                              │   companies.insertIfMissing(source row)
   │                              │   agents.insertIfMissing(source row)
   │                              │   projects.insertIfMissing(source row)
   │                              │   issues.insertIfMissing(source row + identifier)
   │                              │   labels, comments, …
   │                              └──── on uuid collision: skip + warn
```

Both source and destination use the *same* `companyPortabilityService(db)` factory, just bound to different `Db` handles. The bundle format is in-memory (`Record<string, CompanyPortabilityFileEntry>`) — no disk round-trip.

### Coverage today

| Entity | preserveIds-aware? | Manifest field | Service method |
|---|---|---|---|
| Companies | ✓ | `id`, `issuePrefix`, `issueCounter` | `companyService.insertIfMissing` |
| Agents | ✓ | `id` | `agentService.insertIfMissing` |
| Projects | ✓ | `id` | `projectService.insertIfMissing` |
| Issues | ✓ | `id` + `identifier` verbatim | `issueService.insertIfMissing` |
| Issue labels | ✓ (via parent's labelIds round-trip) | – | `issueService.update` |
| Goals | ✗ — fresh UUIDs | – | – |
| Routines | ✗ — fresh UUIDs | – | – |
| Skills | ✗ — fresh UUIDs | – | – |
| Project workspaces | ✗ — fresh UUIDs | – | – |
| Issue comments | ✗ — fresh UUIDs | – | – |

Bookmarked URLs to the ✓ entities survive. Links to ✗ entities break. The wizard's "Keep URLs working" toggle copy is honest about this distinction.

### How identifier preservation works

Issue identifiers (`ACM-42`) are globally unique. The `issues.create` path uses a self-correcting counter:

```sql
issueCounter = greatest(companies.issueCounter, max(issues.issueNumber)) + 1
```

This means `insertIfMissing` doesn't need to touch `companies.issueCounter` — future creates auto-skip past imported numbers. See the comment block above `issueService.insertIfMissing` for the full rationale.

### Extending to a new entity

The pattern is mechanical. To preserve IDs on a new entity (e.g. goals):

1. **Validator schema** — add optional `id` to the entity's manifest schema (`packages/shared/src/validators/company-portability.ts`).
2. **Type** — mirror it on the hand-written interface (`packages/shared/src/types/company-portability.ts`).
3. **Service method** — add `insertIfMissing(data: typeof <table>.$inferInsert)` to the entity's service that wraps `db.insert(table).values(data).onConflictDoNothing({ target: table.id })`.
4. **Export YAML writer** — emit `id: entity.id` in the entity's `paperclip*Out[slug]` extension construction.
5. **Manifest reader** — parse `id: asString(extension.id) ?? undefined` in `buildManifestFromPackageFiles`.
6. **Import branch** — at the entity's create call site in `importBundle`, fork on `options?.preserveIds && manifestEntry.id` and route through `<entity>.insertIfMissing` instead of `<entity>.create`.
7. **Integration test** — assert the source UUID survives end-to-end.

Steps 4 and 5 are easy to forget (the YAML round-trip). The existing integration test caught exactly this for issues — extending coverage should always come with a test that asserts the UUID resolves at the destination.

---

## Operational concerns

### Concurrent runs

In-memory mutex on `POST /migrate` and `POST /local-export/apply`. Second caller gets `409`. Read endpoints (status, preview, validate) interleave freely.

The mutex is intentionally scoped to *mutations*, not the wizard's view. Multiple tabs open simultaneously is fine — they share the GET responses via React Query's cache.

### Audit trail

Structured pino events with stable `event` keys, since `activity_log` requires a `companyId` that instance-level operations don't have. Grep for:

- `event:"instance.database.migrated"` — actor, applied migrations
- `event:"instance.database.local_export_applied"` — actor, preserveIds flag, include mask, imported/skipped/failed counts, first 5 failures sampled

### Local embedded PG spawning

When the running server uses an external `DATABASE_URL` and the wizard's Import step needs to read the local embedded data dir, it spawns a side-process via `openEmbeddedPostgresIfPresent(dataDir, preferredPort)`.

Behavior matrix:

| Server mode | Local data dir state | Result |
|---|---|---|
| embedded-postgres | (any) | `null` — you ARE the local instance |
| postgres | no PG_VERSION file | `null` — nothing to import |
| postgres | initialized, dormant | spawns fresh; `release()` stops it |
| postgres | initialized, running | adopts; `release()` is no-op |

See `packages/db/src/migration-runtime.ts → ensureEmbeddedPostgresConnection` for the lifecycle implementation. The same helper is used by the migration CLI (`pnpm db:migrate`).

### Failure isolation

The apply pipeline iterates source companies. Each company's import is wrapped in `try/catch`. A failure on company #3 doesn't abort #4, #5, etc. Failures are surfaced in the response under `failed: { companies: N, details: [...] }` and rendered prominently in the wizard's Done step.

There is no destination-side transaction wrapping a single company import — if a company row inserts but a downstream issue fails on a unique constraint, the company + agents + projects are committed. Retry is idempotent (existing rows skipped via `insertIfMissing` returning `null`) but partial-state-within-a-company is a known limitation. To close it, wrap each `importBundle(...)` call in a destination transaction.

---

## Testing

End-to-end coverage lives in `server/src/__tests__/preserve-ids-integration.test.ts`. Spins up two embedded PostgreSQL instances (source + destination), runs migrations on both via the test helper, exercises the full pipeline.

```sh
pnpm --filter @paperclipai/server test preserve-ids-integration
```

| Test case | Asserts |
|---|---|
| `preserves company, agent, project, and issue uuids end-to-end` | preserveIds=true on a fresh destination preserves all four entity UUIDs and the `ACM-42` identifier |
| `isolates per-company failures: one bad company doesn't abort the others` | A pre-seeded collision on `ACM-42` at the destination fails Acme; Beta still imports cleanly; `result.failures[0]` correctly identifies Acme |
| `is idempotent on re-run: second import preserves the first's state without duplicating` | Re-running on the same source/destination doesn't duplicate rows; row counts unchanged; warnings include `/already exists/i` |
| `mints fresh uuids when preserveIds is false` | preserveIds=false produces fresh UUIDs at the destination |

Test fixtures use a `pg_tables`-introspecting `TRUNCATE CASCADE` between cases — new schema tables are cleared automatically, no hand-maintained list to keep in sync.

Total runtime: ~10s for 4 tests including two embedded-PG spinups.

---

## Known limitations

| Limitation | Tracked as | Severity |
|---|---|---|
| Goals, routines, skills, project_workspaces, and issue_comments get fresh UUIDs even with preserveIds | – | medium — extend per the "Extending to a new entity" recipe above |
| Wizard doesn't drive a server restart — operator must `DATABASE_URL`-switch + restart before running | – | medium — could be addressed by integrating with `DevRestartBanner` |
| Auto-opener `firedOnce` ref is in-memory only — refresh re-fires it | – | low — add localStorage persistence if "don't ask again" becomes a need |
| Apply request is synchronous and blocking | – | medium — large source DBs may exceed proxy timeouts; SSE progress streaming would address |
| Partial-state within a single company on failure | – | medium — wrap each `importBundle` in a destination transaction |
| Manifest schemaVersion bumped to 6 but no migration path for old bundles | – | low — old bundles still parse (new fields are optional); only forward-compat tooling notices |

---

## Reference

- Route module: `server/src/routes/instance-database.ts`
- Portability service: `server/src/services/company-portability.ts`
- UI wizard: `ui/src/components/DatabaseSetupWizard.tsx`
- UI auto-opener: `ui/src/components/DatabaseSetupAutoOpener.tsx`
- UI API client: `ui/src/api/instanceDatabase.ts`
- Embedded PG spawn: `packages/db/src/embedded-postgres-spawn.ts`
- Integration tests: `server/src/__tests__/preserve-ids-integration.test.ts`
- Schema (validators): `packages/shared/src/validators/company-portability.ts`
- Schema (types): `packages/shared/src/types/company-portability.ts`
