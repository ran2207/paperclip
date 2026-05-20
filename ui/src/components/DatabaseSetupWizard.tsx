import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  ListChecks,
  Download,
  Check,
  ArrowLeft,
  ArrowRight,
  Loader2,
  X,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  Plug,
} from "lucide-react";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { useDialog } from "../context/DialogContext";
import {
  instanceDatabaseApi,
  type InstanceDatabaseStatus,
  type LocalExportFailure,
  type LocalExportPreview,
  type LocalExportSelection,
  type LocalExportValidation,
} from "../api/instanceDatabase";
import { Link as LinkIcon, AlertCircle, ShieldAlert, XCircle } from "lucide-react";

type Step = 1 | 2 | 3 | 4;

const STEPS: { step: Step; label: string; icon: typeof Database }[] = [
  { step: 1, label: "Connection", icon: Database },
  { step: 2, label: "Schema", icon: ListChecks },
  { step: 3, label: "Import", icon: Download },
  { step: 4, label: "Done", icon: Check },
];

/**
 * Entities the user can independently choose to import. These map 1:1 onto
 * portability's include mask. `companies` is mandatory (parents of everything)
 * and therefore not in this list. Goals/secrets/routines/skills ride along
 * with their parents at the portability layer and are surfaced as read-only
 * "ride-along" counts so the user knows they're included implicitly — adding
 * them as toggleable checkboxes would lie, since the server ignores them.
 */
const SELECTABLE_KEYS = ["agents", "projects", "issues"] as const;
type SelectableKey = (typeof SELECTABLE_KEYS)[number];

const RIDE_ALONG_KEYS = ["companySecrets", "goals", "routines"] as const;
type RideAlongKey = (typeof RIDE_ALONG_KEYS)[number];

const SELECTION_LABELS: Record<SelectableKey | RideAlongKey, string> = {
  agents: "Agents",
  projects: "Projects",
  issues: "Issues",
  companySecrets: "Company secrets",
  goals: "Goals",
  routines: "Routines",
};

const DEFAULT_SELECTION: Record<SelectableKey, boolean> = {
  agents: true,
  projects: true,
  issues: true,
};

/** Build the wire-format selection from the wizard's local state. */
function buildLocalExportSelection(
  selectable: Record<SelectableKey, boolean>,
): LocalExportSelection {
  return {
    companies: true,
    agents: selectable.agents,
    projects: selectable.projects,
    issues: selectable.issues,
    // Ride-along entities are forced on; the server-side route doesn't honor
    // them yet (portability bundles them with parents) but we send them as
    // true so a future server change picks them up by default.
    companySecrets: true,
    goals: true,
    routines: true,
  };
}

const databaseStatusQueryKey = ["instance", "database", "status"] as const;
const localExportPreviewQueryKey = ["instance", "database", "localExport", "preview"] as const;
const localExportValidateQueryKey = (preserveIds: boolean) =>
  ["instance", "database", "localExport", "validate", preserveIds] as const;

export function DatabaseSetupWizard() {
  const { databaseSetupOpen, closeDatabaseSetup } = useDialog();
  const open = databaseSetupOpen;
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<SelectableKey, boolean>>(DEFAULT_SELECTION);
  const [skipImport, setSkipImport] = useState(false);
  const [keepUrlsStable, setKeepUrlsStable] = useState(true);
  const [importResult, setImportResult] = useState<
    {
      totalImported: number;
      warnings: string[];
      failures: LocalExportFailure[];
    } | null
  >(null);
  // Restart handoff: set after a connection-string switch is persisted. The
  // server must reboot to pick up the new config; the wizard polls until it
  // comes back on the new connection. The snapshot is the pre-switch
  // (mode, host, database) tuple — when the polled status differs from it and
  // is reachable, the restart has landed.
  const [restartPending, setRestartPending] = useState(false);
  const [restartIsAutomatic, setRestartIsAutomatic] = useState(false);
  const [preRestartSnapshot, setPreRestartSnapshot] = useState<{
    mode: string;
    host: string | null;
    database: string | null;
  } | null>(null);

  const statusQuery = useQuery({
    queryKey: databaseStatusQueryKey,
    queryFn: () => instanceDatabaseApi.getStatus(),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const previewQuery = useQuery({
    queryKey: localExportPreviewQueryKey,
    queryFn: () => instanceDatabaseApi.previewLocalExport(),
    enabled: open && step === 3,
    refetchOnWindowFocus: false,
  });

  const validateQuery = useQuery({
    queryKey: localExportValidateQueryKey(keepUrlsStable),
    queryFn: () =>
      instanceDatabaseApi.validateLocalExport({ preserveIds: keepUrlsStable }),
    enabled: open && step === 3 && !skipImport,
    refetchOnWindowFocus: false,
  });

  // Polls the status endpoint while waiting for a post-switch restart. retry
  // false + a fixed interval means failed fetches (server mid-restart) just
  // schedule the next poll instead of surfacing an error.
  const restartWatchQuery = useQuery({
    queryKey: ["instance", "database", "status", "restart-watch"] as const,
    queryFn: () => instanceDatabaseApi.getStatus(),
    enabled: open && restartPending,
    refetchInterval: restartPending ? 3000 : false,
    retry: false,
    gcTime: 0,
  });

  const migrate = useMutation({
    mutationFn: () => instanceDatabaseApi.applyMigrations(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: databaseStatusQueryKey });
      setError(null);
      setStep(3);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Migration failed"),
  });

  const importLocal = useMutation({
    mutationFn: (input: { selection: LocalExportSelection; preserveIds: boolean }) =>
      instanceDatabaseApi.applyLocalExport(input),
    onSuccess: (result) => {
      const totalImported = Object.values(result.imported).reduce<number>(
        (sum, v) => sum + (v ?? 0),
        0,
      );
      setImportResult({
        totalImported,
        warnings: result.warnings,
        failures: result.failed.details,
      });
      setError(null);
      setStep(4);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Import failed"),
  });

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setError(null);
    setSelection({ ...DEFAULT_SELECTION });
    setSkipImport(false);
    setKeepUrlsStable(true);
    setImportResult(null);
    setRestartPending(false);
    setRestartIsAutomatic(false);
    setPreRestartSnapshot(null);
  }, [open]);

  // Detect that a post-switch restart has landed: the polled status differs
  // from the pre-switch snapshot and is reachable.
  useEffect(() => {
    if (!restartPending) return;
    const s = restartWatchQuery.data;
    if (!s || !s.reachable) return;
    const snap = preRestartSnapshot;
    const landed =
      !snap || s.mode !== snap.mode || s.host !== snap.host || s.database !== snap.database;
    if (!landed) return;
    setRestartPending(false);
    setPreRestartSnapshot(null);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: databaseStatusQueryKey });
    setStep(s.schemaPresent && s.pendingMigrations.length === 0 ? 3 : 2);
  }, [restartPending, restartWatchQuery.data, preRestartSnapshot, queryClient]);

  const status = statusQuery.data;
  const isReady = useMemo(
    () => Boolean(status?.reachable && status.schemaPresent && status.pendingMigrations.length === 0),
    [status],
  );

  function handleClose() {
    closeDatabaseSetup();
  }

  function handleNextFromConnection() {
    if (!status?.reachable) {
      setError("Database is not reachable. Check the connection string and try again.");
      return;
    }
    setError(null);
    if (isReady) {
      setStep(3);
      return;
    }
    setStep(2);
  }

  function handleApplyMigrations() {
    setError(null);
    migrate.mutate();
  }

  function handleImport() {
    if (skipImport) {
      setImportResult({ totalImported: 0, warnings: [], failures: [] });
      setStep(4);
      return;
    }
    importLocal.mutate({
      selection: buildLocalExportSelection(selection),
      preserveIds: keepUrlsStable,
    });
  }

  function toggleSelection(key: SelectableKey) {
    setSelection((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleConnectionSwitched(autoRestart: boolean) {
    setPreRestartSnapshot(
      status
        ? { mode: status.mode, host: status.host, database: status.database }
        : null,
    );
    setRestartIsAutomatic(autoRestart);
    setRestartPending(true);
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="relative w-full max-w-2xl rounded-lg border border-border bg-card shadow-sm">
            <button
              onClick={handleClose}
              className="absolute top-3 right-3 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>

            <div className="px-6 pt-6 pb-2">
              <h2 className="text-lg font-semibold">Database setup</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Verify the connection, run schema migrations, and optionally import from your local instance.
              </p>
            </div>

            {restartPending ? (
              <RestartHandoff
                watchStatus={restartWatchQuery.data}
                automatic={restartIsAutomatic}
                onRecheck={() => void restartWatchQuery.refetch()}
                onClose={handleClose}
              />
            ) : (
              <>
            <div className="flex items-center gap-0 px-6 border-b border-border">
              {STEPS.map(({ step: s, label, icon: Icon }) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => s < step && setStep(s)}
                  disabled={s > step}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                    s === step
                      ? "border-foreground text-foreground"
                      : s < step
                        ? "border-transparent text-muted-foreground hover:text-foreground/70 cursor-pointer"
                        : "border-transparent text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="px-6 py-5 min-h-[280px]">
              {step === 1 && (
                <ConnectionStep
                  status={status}
                  loading={statusQuery.isLoading}
                  fetchError={statusQuery.error}
                  onRefresh={() => statusQuery.refetch()}
                  onConnectionSwitched={handleConnectionSwitched}
                />
              )}
              {step === 2 && status && (
                <SchemaStep
                  status={status}
                  applying={migrate.isPending}
                  onApply={handleApplyMigrations}
                />
              )}
              {step === 3 && (
                <ImportStep
                  preview={previewQuery.data}
                  loading={previewQuery.isLoading}
                  skip={skipImport}
                  onToggleSkip={() => setSkipImport((s) => !s)}
                  selection={selection}
                  onToggle={toggleSelection}
                  keepUrlsStable={keepUrlsStable}
                  onToggleKeepUrlsStable={() => setKeepUrlsStable((v) => !v)}
                  validation={validateQuery.data}
                  validating={validateQuery.isLoading}
                />
              )}
              {step === 4 && (
                <DoneStep
                  status={status}
                  importedCount={importResult?.totalImported ?? 0}
                  skipped={skipImport}
                  warnings={importResult?.warnings ?? []}
                  failures={importResult?.failures ?? []}
                />
              )}

              {error && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-border">
              <div>
                {step > 1 && step < 4 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep((step - 1) as Step)}
                    disabled={migrate.isPending || importLocal.isPending}
                  >
                    <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                    Back
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {step === 1 && (
                  <Button
                    size="sm"
                    disabled={!status || statusQuery.isLoading}
                    onClick={handleNextFromConnection}
                  >
                    <ArrowRight className="h-3.5 w-3.5 mr-1" />
                    {isReady ? "Continue" : "Next"}
                  </Button>
                )}
                {step === 2 && (
                  <Button
                    size="sm"
                    disabled={migrate.isPending || !status?.reachable}
                    onClick={handleApplyMigrations}
                  >
                    {migrate.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                    )}
                    {migrate.isPending ? "Applying..." : "Apply migrations"}
                  </Button>
                )}
                {step === 3 && (
                  <Button
                    size="sm"
                    disabled={
                      importLocal.isPending ||
                      (!skipImport &&
                        (validateQuery.isLoading ||
                          (validateQuery.data?.errors.length ?? 0) > 0))
                    }
                    onClick={handleImport}
                  >
                    {importLocal.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                    )}
                    {skipImport
                      ? "Skip import"
                      : importLocal.isPending
                        ? "Importing..."
                        : "Import selected"}
                  </Button>
                )}
                {step === 4 && (
                  <Button size="sm" onClick={handleClose}>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Done
                  </Button>
                )}
              </div>
            </div>
              </>
            )}
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function ConnectionStep({
  status,
  loading,
  fetchError,
  onRefresh,
  onConnectionSwitched,
}: {
  status: InstanceDatabaseStatus | undefined;
  loading: boolean;
  fetchError: unknown;
  onRefresh: () => void;
  onConnectionSwitched: (autoRestart: boolean) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Probing database…
      </div>
    );
  }

  if (fetchError || !status) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Could not reach the database status endpoint.</span>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="bg-muted/50 p-2 rounded-md">
          <Database className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium">
            {status.mode === "embedded-postgres" ? "Embedded Postgres" : "External Postgres"}
          </h3>
          <p className="text-xs text-muted-foreground font-mono">
            {status.host ?? "local"}
            {status.database ? ` / ${status.database}` : ""}
          </p>
        </div>
      </div>

      <div className="border border-border rounded-md divide-y divide-border">
        <PropertyRow label="Reachable" value={<StatusPill ok={status.reachable} okLabel="Yes" failLabel="No" />} />
        <PropertyRow
          label="Schema present"
          value={
            <StatusPill
              ok={status.schemaPresent}
              okLabel="Yes"
              failLabel="Not initialized"
              neutralOnFail
            />
          }
        />
        <PropertyRow
          label="Pending migrations"
          value={
            status.pendingMigrations.length === 0 ? (
              <span className="text-xs text-muted-foreground">None</span>
            ) : (
              <span className="text-xs font-mono">
                {status.pendingMigrations.length}
              </span>
            )
          }
        />
        <PropertyRow
          label="Tables"
          value={<span className="text-xs font-mono text-muted-foreground">{status.tables.length}</span>}
        />
      </div>

      <ConnectionEditor
        currentMode={status.mode}
        onConnectionSwitched={onConnectionSwitched}
      />
    </div>
  );
}

/**
 * Heuristic: does this connection string point at a transaction-mode
 * connection pooler? Paperclip's postgres.js client uses prepared statements,
 * which break on PgBouncer-style transaction poolers. Covers Neon (`-pooler`
 * in the host) and Supabase (`.pooler.` host, port 6543).
 */
function looksLikePooler(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.hostname.toLowerCase().includes("pooler")) return true;
    if (url.port === "6543") return true;
    return false;
  } catch {
    return false;
  }
}

function ConnectionEditor({
  currentMode,
  onConnectionSwitched,
}: {
  currentMode: InstanceDatabaseStatus["mode"];
  onConnectionSwitched: (autoRestart: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [connectionString, setConnectionString] = useState("");
  const [error, setError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: (s: string) => instanceDatabaseApi.testConnection(s),
    onMutate: () => setError(null),
  });
  const setConn = useMutation({
    mutationFn: (s: string) => instanceDatabaseApi.setConnection(s),
    onSuccess: (result) => onConnectionSwitched(result.autoRestart),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to save the connection."),
  });
  const useEmbedded = useMutation({
    mutationFn: () => instanceDatabaseApi.useEmbedded(),
    onMutate: () => setError(null),
    onSuccess: (result) => onConnectionSwitched(result.autoRestart),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Failed to switch to the embedded database.",
      ),
  });
  const isExternal = currentMode === "postgres";

  const trimmed = connectionString.trim();
  const looksValid = /^postgres(ql)?:\/\//.test(trimmed);
  const pooledSuspected = looksLikePooler(trimmed);
  const testedOk = test.data?.reachable === true;
  // A test result only applies to the string it was run against. Editing the
  // input after a successful test must re-gate the switch button.
  const [testedString, setTestedString] = useState<string | null>(null);
  const testIsCurrent = testedOk && testedString === trimmed;

  if (!expanded) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown className="h-3 w-3 -rotate-90" />
          Connect to a different database
        </button>

        {isExternal && (
          <button
            type="button"
            onClick={() => useEmbedded.mutate()}
            disabled={useEmbedded.isPending}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {useEmbedded.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Database className="h-3 w-3" />
            )}
            {useEmbedded.isPending
              ? "Switching…"
              : "Switch back to the bundled embedded Postgres"}
          </button>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">Connect to a different database</p>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>

      <div>
        <label className="text-[11px] text-muted-foreground mb-1 block">
          PostgreSQL connection string
        </label>
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/40"
          placeholder="postgres://user:password@host:5432/database"
          value={connectionString}
          onChange={(e) => {
            setConnectionString(e.target.value);
            setError(null);
          }}
        />
        <p className="text-[10px] text-muted-foreground/70 mt-1">
          Stored in the instance config file (mode 0600). The server must restart
          to connect to it.
        </p>
      </div>

      {pooledSuspected && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 dark:border-amber-500/40 bg-amber-50/50 dark:bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          <span>
            This looks like a connection-<strong>pooler</strong> endpoint. Paperclip
            uses prepared statements, which fail on transaction-mode poolers — use
            the <strong>direct</strong> (non-pooled) connection string instead. A
            pooler can even pass the test below, then break at runtime.
          </span>
        </div>
      )}

      {test.data && (
        test.data.reachable ? (
          <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-2.5 py-1.5 text-[11px] text-green-700 dark:text-green-300">
            <Check className="h-3 w-3 shrink-0" />
            <span>
              Reachable.{" "}
              {test.data.schemaPresent
                ? `Schema present${
                    test.data.pendingMigrations.length > 0
                      ? `, ${test.data.pendingMigrations.length} pending migrations`
                      : ""
                  }.`
                : "Schema not initialized — the wizard will run migrations."}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>{test.data.error ?? "Could not connect."}</span>
          </div>
        )
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={!looksValid || test.isPending}
          onClick={() => {
            setTestedString(trimmed);
            test.mutate(trimmed);
          }}
        >
          {test.isPending ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Plug className="h-3 w-3 mr-1" />
          )}
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={!testIsCurrent || setConn.isPending}
          onClick={() => setConn.mutate(trimmed)}
        >
          {setConn.isPending ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <ArrowRight className="h-3 w-3 mr-1" />
          )}
          {setConn.isPending ? "Saving…" : "Switch database"}
        </Button>
      </div>
    </div>
  );
}

function RestartHandoff({
  watchStatus,
  automatic,
  onRecheck,
  onClose,
}: {
  watchStatus: InstanceDatabaseStatus | undefined;
  automatic: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  return (
    <div className="px-6 py-8 space-y-4">
      <div className="flex items-center gap-3">
        <div className="bg-muted/50 p-2 rounded-md">
          <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
        </div>
        <div>
          <h3 className="text-sm font-medium">
            {automatic ? "Restarting the server…" : "Restart required"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {automatic
              ? "The new connection is saved. The server is restarting itself to connect to it — no action needed."
              : "The new connection is saved. Restart the Paperclip server to connect to it."}
          </p>
        </div>
      </div>

      {!automatic && (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <p className="text-[11px] text-muted-foreground mb-1">In your terminal:</p>
          <code className="text-xs font-mono">
            restart the Paperclip server (e.g. re-run pnpm dev)
          </code>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Waiting for the server to come back on the new connection…
        {watchStatus?.reachable ? " (reachable — confirming the switch)" : ""}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRecheck}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Re-check now
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close — I&rsquo;ll finish setup later
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
        {automatic
          ? "This usually takes a few seconds. If the server doesn't come back, restart it manually — the wizard will reconnect either way."
          : "After the restart this wizard reopens automatically against the new database if its schema needs setup."}
      </p>
    </div>
  );
}

function SchemaStep({
  status,
  applying,
  onApply,
}: {
  status: InstanceDatabaseStatus;
  applying: boolean;
  onApply: () => void;
}) {
  if (status.pendingMigrations.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300">
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Schema is up to date.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="bg-muted/50 p-2 rounded-md">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium">
            {status.appliedMigrations.length === 0
              ? "Initialize schema"
              : "Apply pending migrations"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {status.pendingMigrations.length} migration{status.pendingMigrations.length === 1 ? "" : "s"}{" "}
            will run against{" "}
            <span className="font-mono">{status.database ?? status.host ?? "this database"}</span>.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-border max-h-48 overflow-y-auto">
        <ul className="divide-y divide-border">
          {status.pendingMigrations.map((name) => (
            <li
              key={name}
              className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground"
            >
              <ArrowRight className="h-3 w-3 shrink-0" />
              {name}
            </li>
          ))}
        </ul>
      </div>

      {applying && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Running migrations…
        </div>
      )}
    </div>
  );
}

function ImportStep({
  preview,
  loading,
  skip,
  onToggleSkip,
  selection,
  onToggle,
  keepUrlsStable,
  onToggleKeepUrlsStable,
  validation,
  validating,
}: {
  preview: LocalExportPreview | undefined;
  loading: boolean;
  skip: boolean;
  onToggleSkip: () => void;
  selection: Record<SelectableKey, boolean>;
  onToggle: (key: SelectableKey) => void;
  keepUrlsStable: boolean;
  onToggleKeepUrlsStable: () => void;
  validation: LocalExportValidation | undefined;
  validating: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Inspecting local instance…
      </div>
    );
  }

  if (!preview?.reachable) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="bg-muted/50 p-2 rounded-md">
            <Download className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-medium">No local instance found</h3>
            <p className="text-xs text-muted-foreground">
              We could not reach a local embedded database on this machine.
              Continue to finish setup with an empty database.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const counts = preview.counts;
  const totalAvailable = Object.values(counts).reduce<number>((s, v) => s + v, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="bg-muted/50 p-2 rounded-md">
          <Download className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium">Import from your local instance?</h3>
          <p className="text-xs text-muted-foreground">
            Found {totalAvailable} record{totalAvailable === 1 ? "" : "s"} in{" "}
            <span className="font-mono">{preview.source.database ?? "local"}</span>. Choose what to copy.
          </p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          checked={skip}
          onChange={onToggleSkip}
          className="h-3.5 w-3.5 accent-foreground"
        />
        <span className={cn(skip ? "text-foreground" : "text-muted-foreground")}>
          Skip — start with an empty database
        </span>
      </label>

      <div
        className={cn(
          "flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 transition-opacity",
          skip && "opacity-40 pointer-events-none",
        )}
      >
        <LinkIcon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium">Keep URLs working</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            Preserves source UUIDs for companies, agents, projects, and issues — including issue
            identifiers like <span className="font-mono">ACM-42</span>. Bookmarked links to those
            entities keep resolving. Goals, routines, comments, and skills still get fresh IDs.
            Turn off only to import into a destination that already has companies using the same
            issue prefix.
          </p>
        </div>
        <ToggleSwitch checked={keepUrlsStable} onCheckedChange={onToggleKeepUrlsStable} />
      </div>

      <div
        className={cn(
          "border border-border rounded-md divide-y divide-border transition-opacity",
          skip && "opacity-40 pointer-events-none",
        )}
      >
        {/* Companies are mandatory — shown as a read-only row so the user sees the count. */}
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/30">
          <div className="flex items-center gap-2.5">
            <Check className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm">Companies</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">required</span>
          </div>
          <span className="text-xs font-mono text-muted-foreground">{counts.companies}</span>
        </div>

        {SELECTABLE_KEYS.map((key) => {
          const count = counts[key];
          return (
            <label
              key={key}
              className="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50"
            >
              <div className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={selection[key]}
                  onChange={() => onToggle(key)}
                  disabled={count === 0}
                  className="h-3.5 w-3.5 accent-foreground"
                />
                <span
                  className={cn(
                    "text-sm",
                    count === 0 ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {SELECTION_LABELS[key]}
                </span>
              </div>
              <span className="text-xs font-mono text-muted-foreground">{count}</span>
            </label>
          );
        })}

        {/* Ride-along entities — bundled with their parents at the portability
            layer; not independently toggleable. Shown as info rows so the user
            knows what's coming along. */}
        {RIDE_ALONG_KEYS.map((key) => {
          const count = counts[key];
          if (count === 0) return null;
          return (
            <div
              key={key}
              className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/10"
            >
              <div className="flex items-center gap-2.5">
                <span className="h-3.5 w-3.5" />
                <span className="text-sm text-muted-foreground">{SELECTION_LABELS[key]}</span>
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">rides along</span>
              </div>
              <span className="text-xs font-mono text-muted-foreground">{count}</span>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Adapter secrets referenced by imported agents are re-encrypted with the destination
        instance&rsquo;s master key. Existing rows in the target database are preserved — only
        missing IDs are inserted.
      </p>

      {!skip && (
        <ValidationPanel validation={validation} validating={validating} />
      )}
    </div>
  );
}

function ValidationPanel({
  validation,
  validating,
}: {
  validation: LocalExportValidation | undefined;
  validating: boolean;
}) {
  if (validating) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking destination compatibility…
      </div>
    );
  }
  if (!validation) return null;
  const { errors, warnings } = validation;
  if (errors.length === 0 && warnings.length === 0) return null;

  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <ValidationList kind="error" issues={errors} />
      )}
      {warnings.length > 0 && (
        <ValidationList kind="warning" issues={warnings} />
      )}
    </div>
  );
}

function ValidationList({
  kind,
  issues,
}: {
  kind: "error" | "warning";
  issues: { code: string; message: string }[];
}) {
  const palette =
    kind === "error"
      ? {
          border: "border-destructive/40",
          bg: "bg-destructive/10",
          accent: "text-destructive",
          icon: ShieldAlert,
          label: `Cannot continue — ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
        }
      : {
          border: "border-amber-300/60 dark:border-amber-500/40",
          bg: "bg-amber-50/50 dark:bg-amber-500/10",
          accent: "text-amber-700 dark:text-amber-300",
          icon: AlertCircle,
          label: `${issues.length} warning${issues.length === 1 ? "" : "s"}`,
        };
  const Icon = palette.icon;
  return (
    <div className={cn("rounded-md border", palette.border, palette.bg)}>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 border-b",
          palette.border,
        )}
      >
        <Icon className={cn("h-3.5 w-3.5 shrink-0", palette.accent)} />
        <span className={cn("text-xs font-medium", palette.accent)}>
          {palette.label}
        </span>
      </div>
      <ul className={cn("max-h-40 overflow-y-auto divide-y", palette.border)}>
        {issues.map((issue, i) => (
          <li
            key={`${issue.code}-${i}`}
            className={cn("px-3 py-1.5 text-[11px] leading-relaxed", palette.accent)}
          >
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DoneStep({
  status,
  importedCount,
  skipped,
  warnings,
  failures,
}: {
  status: InstanceDatabaseStatus | undefined;
  importedCount: number;
  skipped: boolean;
  warnings: string[];
  failures: LocalExportFailure[];
}) {
  const hasFailures = failures.length > 0;
  // When any company failed, lead with the failure summary rather than the
  // "ready" green checkmark — the success framing would mislead.
  const headlineClass = hasFailures
    ? "bg-destructive/10 text-destructive"
    : "bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400";
  const HeadlineIcon = hasFailures ? XCircle : Check;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className={cn("p-2 rounded-md", headlineClass)}>
          <HeadlineIcon className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-medium">
            {hasFailures
              ? `Imported ${importedCount} record${importedCount === 1 ? "" : "s"}, ${failures.length} compan${failures.length === 1 ? "y" : "ies"} failed`
              : "Database is ready"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {skipped
              ? "Schema is initialized. No data was imported."
              : hasFailures
                ? "Successful imports are committed. Re-run the wizard to retry failed companies — already-imported ones will be skipped idempotently."
                : `Imported ${importedCount} record${importedCount === 1 ? "" : "s"} from your local instance.`}
          </p>
        </div>
      </div>

      {status && (
        <div className="border border-border rounded-md divide-y divide-border">
          <PropertyRow
            label="Connection"
            value={
              <span className="text-xs font-mono text-muted-foreground">
                {status.host ?? "local"}
                {status.database ? ` / ${status.database}` : ""}
              </span>
            }
          />
          <PropertyRow
            label="Tables"
            value={<span className="text-xs font-mono text-muted-foreground">{status.tables.length}</span>}
          />
        </div>
      )}

      {hasFailures && <FailureList failures={failures} />}
      {warnings.length > 0 && <WarningList warnings={warnings} />}
    </div>
  );
}

function FailureList({ failures }: { failures: LocalExportFailure[] }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-destructive/30">
        <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
        <span className="text-xs font-medium text-destructive">
          {failures.length} compan{failures.length === 1 ? "y" : "ies"} failed
        </span>
      </div>
      <ul className="max-h-40 overflow-y-auto divide-y divide-destructive/20">
        {failures.map((f) => (
          <li key={f.sourceCompanyId} className="px-3 py-1.5 text-[11px] leading-relaxed">
            <div className="font-medium text-destructive">{f.sourceCompanyName}</div>
            <div className="text-destructive/80 font-mono break-words mt-0.5">
              {f.message}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-md border border-amber-300/60 dark:border-amber-500/40 bg-amber-50/50 dark:bg-amber-500/10">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-300/40 dark:border-amber-500/30">
        <AlertCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
        <span className="text-xs font-medium text-amber-900 dark:text-amber-200">
          {warnings.length} warning{warnings.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="max-h-40 overflow-y-auto divide-y divide-amber-300/30 dark:divide-amber-500/20">
        {warnings.map((w, i) => (
          <li
            key={i}
            className="px-3 py-1.5 text-[11px] leading-relaxed text-amber-900/90 dark:text-amber-200/90 font-mono break-words"
          >
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PropertyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}

function StatusPill({
  ok,
  okLabel,
  failLabel,
  neutralOnFail = false,
}: {
  ok: boolean;
  okLabel: string;
  failLabel: string;
  neutralOnFail?: boolean;
}) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300">
        <Check className="h-3 w-3" />
        {okLabel}
      </span>
    );
  }
  const cls = neutralOnFail
    ? "border-border bg-muted/40 text-muted-foreground"
    : "border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", cls)}>
      {failLabel}
    </span>
  );
}
