import { api } from "./client";

export type InstanceDatabaseMode = "embedded-postgres" | "postgres";

export interface InstanceDatabaseStatus {
  mode: InstanceDatabaseMode;
  host: string | null;
  database: string | null;
  reachable: boolean;
  schemaPresent: boolean;
  appliedMigrations: string[];
  pendingMigrations: string[];
  tables: { name: string; rowCount: number }[];
}

export interface LocalExportPreview {
  reachable: boolean;
  source: { mode: InstanceDatabaseMode; host: string | null; database: string | null };
  counts: {
    companies: number;
    agents: number;
    companySecrets: number;
    projects: number;
    goals: number;
    issues: number;
    routines: number;
  };
}

export interface LocalExportSelection {
  companies: boolean;
  agents: boolean;
  companySecrets: boolean;
  projects: boolean;
  goals: boolean;
  issues: boolean;
  routines: boolean;
}

export interface LocalExportFailure {
  sourceCompanyId: string;
  sourceCompanyName: string;
  message: string;
}

export interface LocalExportResult {
  imported: { companies: number; agents: number };
  skipped: { companies: number; agents: number };
  /**
   * Per-company import failures. The pipeline isolates errors per source
   * company — already-imported companies stay committed and downstream
   * companies still attempt. Surface these prominently in the UI so the
   * user can retry (already-imported companies are idempotent).
   */
  failed: { companies: number; details: LocalExportFailure[] };
  warnings: string[];
}

export interface ApplyLocalExportInput {
  selection: LocalExportSelection;
  /**
   * When true (default), preserve source UUIDs and issue identifiers so
   * bookmarked URLs survive the migration. Surface in the wizard as a
   * "Keep URLs working" toggle.
   */
  preserveIds: boolean;
}

export interface ValidationIssue {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface LocalExportValidation {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface TestConnectionResult {
  reachable: boolean;
  schemaPresent: boolean;
  pendingMigrations: string[];
  error?: string;
}

export const instanceDatabaseApi = {
  getStatus: () => api.get<InstanceDatabaseStatus>("/instance/database/status"),
  applyMigrations: () =>
    api.post<{ applied: string[] }>("/instance/database/migrate", {}),
  testConnection: (connectionString: string) =>
    api.post<TestConnectionResult>("/instance/database/test-connection", {
      connectionString,
    }),
  setConnection: (connectionString: string) =>
    api.post<{ persisted: boolean; restartRequired: boolean; autoRestart: boolean }>(
      "/instance/database/connection",
      { connectionString },
    ),
  useEmbedded: () =>
    api.post<{ persisted: boolean; restartRequired: boolean; autoRestart: boolean }>(
      "/instance/database/use-embedded",
      {},
    ),
  previewLocalExport: () =>
    api.get<LocalExportPreview>("/instance/database/local-export/preview"),
  validateLocalExport: (input: { preserveIds: boolean }) =>
    api.post<LocalExportValidation>("/instance/database/local-export/validate", input),
  applyLocalExport: (input: ApplyLocalExportInput) =>
    api.post<LocalExportResult>("/instance/database/local-export/apply", input),
};
