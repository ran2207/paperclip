import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, companies, agents, projects, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { copyEntitiesViaPortability } from "../routes/instance-database.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping preserveIds integration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * Truncate every user table in the public schema with CASCADE. Driven by
 * pg_tables introspection so a new entity table added to the schema doesn't
 * silently leak between tests — the previous hand-maintained list rotted as
 * soon as someone forgot to add a new table to it. Excludes the migrations
 * journal (managed by Drizzle, not test data). Single SQL statement to avoid
 * the FK-order dance.
 */
async function clearAll(db: ReturnType<typeof createDb>) {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '__drizzle_migrations'`,
  );
  if (rows.length === 0) return;
  const idents = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE`));
}

describeEmbeddedPostgres("database setup wizard — preserveIds end-to-end", () => {
  let sourceDb!: ReturnType<typeof createDb>;
  let destDb!: ReturnType<typeof createDb>;
  let sourceTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let destTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    sourceTempDb = await startEmbeddedPostgresTestDatabase("paperclip-preserveids-src-");
    destTempDb = await startEmbeddedPostgresTestDatabase("paperclip-preserveids-dst-");
    sourceDb = createDb(sourceTempDb.connectionString);
    destDb = createDb(destTempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await clearAll(sourceDb);
    await clearAll(destDb);
  });

  afterAll(async () => {
    await sourceTempDb?.cleanup();
    await destTempDb?.cleanup();
  });

  /**
   * Seed a single-company source with one agent, one project, and one issue at
   * a known identifier so tests can assert on exact uuids / identifiers.
   */
  async function seedSource() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();

    await sourceDb.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: "ACM",
      issueCounter: 42,
      requireBoardApprovalForNewAgents: false,
    });

    await sourceDb.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 0,
    });

    await sourceDb.insert(projects).values({
      id: projectId,
      companyId,
      name: "Core",
      color: "#5c5fff",
    });

    await sourceDb.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      issueNumber: 42,
      identifier: "ACM-42",
      title: "First task",
      status: "todo",
      priority: "medium",
    });

    return { companyId, agentId, projectId, issueId };
  }

  it("preserves company, agent, project, and issue uuids end-to-end", async () => {
    const seeded = await seedSource();

    const sourcePortability = companyPortabilityService(sourceDb);
    const destPortability = companyPortabilityService(destDb);

    const bundle = await sourcePortability.exportBundle(seeded.companyId, {
      include: { company: true, agents: true, projects: true, issues: true },
    });

    const result = await destPortability.importBundle(
      {
        source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
        include: { company: true, agents: true, projects: true, issues: true },
        target: { mode: "new_company", newCompanyName: "Acme" },
        collisionStrategy: "skip",
      },
      /* actorUserId */ null,
      { preserveIds: true },
    );

    expect(result.company.action).toBe("created");

    const destCompany = await destDb
      .select()
      .from(companies)
      .where(eq(companies.id, seeded.companyId))
      .then((rows) => rows[0] ?? null);
    expect(destCompany).not.toBeNull();
    expect(destCompany!.issuePrefix).toBe("ACM");
    expect(destCompany!.issueCounter).toBeGreaterThanOrEqual(42);

    const destAgent = await destDb
      .select()
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0] ?? null);
    expect(destAgent).not.toBeNull();
    expect(destAgent!.name).toBe("CEO");

    const destProject = await destDb
      .select()
      .from(projects)
      .where(eq(projects.id, seeded.projectId))
      .then((rows) => rows[0] ?? null);
    expect(destProject).not.toBeNull();

    const destIssue = await destDb
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(destIssue).not.toBeNull();
    expect(destIssue!.identifier).toBe("ACM-42");
    expect(destIssue!.issueNumber).toBe(42);
  }, 60_000);

  it("isolates per-company failures: one bad company doesn't abort the others", async () => {
    // Seed source with TWO companies. Acme has an issue at ACM-42; the
    // destination will be pre-seeded with a different issue at the same
    // identifier so Acme's issue insert collides and throws. Beta should
    // import cleanly regardless.
    const acmeCompanyId = randomUUID();
    const acmeIssueId = randomUUID();
    const betaCompanyId = randomUUID();
    const betaIssueId = randomUUID();

    await sourceDb.insert(companies).values([
      {
        id: acmeCompanyId,
        name: "Acme",
        issuePrefix: "ACM",
        issueCounter: 42,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: betaCompanyId,
        name: "Beta",
        issuePrefix: "BTA",
        issueCounter: 7,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await sourceDb.insert(issues).values([
      {
        id: acmeIssueId,
        companyId: acmeCompanyId,
        issueNumber: 42,
        identifier: "ACM-42",
        title: "Acme task",
        status: "todo",
        priority: "medium",
      },
      {
        id: betaIssueId,
        companyId: betaCompanyId,
        issueNumber: 7,
        identifier: "BTA-7",
        title: "Beta task",
        status: "todo",
        priority: "medium",
      },
    ]);

    // Pre-seed destination with a different company that already owns the
    // identifier ACM-42. Source's Acme issue will collide on insert.
    const squatterCompanyId = randomUUID();
    const squatterIssueId = randomUUID();
    await destDb.insert(companies).values({
      id: squatterCompanyId,
      name: "Squatter",
      issuePrefix: "SQT",
      issueCounter: 1,
      requireBoardApprovalForNewAgents: false,
    });
    await destDb.insert(issues).values({
      id: squatterIssueId,
      companyId: squatterCompanyId,
      issueNumber: 1,
      identifier: "ACM-42",
      title: "Pre-existing collision",
      status: "todo",
      priority: "medium",
    });

    // No logos / attachments in this seed, so the storage stub's methods
    // never get called — the type satisfies the interface, that's all that
    // matters here.
    const noopStorage = {
      provider: "local_disk",
      putFile: async () => { throw new Error("storage should not be called"); },
      getObject: async () => { throw new Error("storage should not be called"); },
      headObject: async () => { throw new Error("storage should not be called"); },
      deleteObject: async () => { throw new Error("storage should not be called"); },
    } as unknown as StorageService;

    const result = await copyEntitiesViaPortability({
      sourceUrl: sourceTempDb!.connectionString,
      db: destDb,
      storage: noopStorage,
      companyIds: [],
      include: { company: true, agents: false, projects: false, issues: true },
      preserveIds: true,
    });

    // Inter-company isolation: Beta should import despite Acme's failure.
    expect(result.companies.failed).toBe(1);
    expect(result.companies.created).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].sourceCompanyName).toBe("Acme");
    expect(result.failures[0].sourceCompanyId).toBe(acmeCompanyId);
    expect(result.failures[0].message.length).toBeGreaterThan(0);

    // Beta's data made it.
    const destBeta = await destDb
      .select()
      .from(companies)
      .where(eq(companies.id, betaCompanyId))
      .then((rows) => rows[0] ?? null);
    expect(destBeta).not.toBeNull();
    expect(destBeta!.issuePrefix).toBe("BTA");

    const destBetaIssue = await destDb
      .select()
      .from(issues)
      .where(eq(issues.id, betaIssueId))
      .then((rows) => rows[0] ?? null);
    expect(destBetaIssue).not.toBeNull();
    expect(destBetaIssue!.identifier).toBe("BTA-7");

    // Acme's failed-issue is NOT at the destination (the unique constraint
    // rejected the insert). The squatter row that owns ACM-42 still does.
    const destAcmeIssue = await destDb
      .select()
      .from(issues)
      .where(eq(issues.id, acmeIssueId))
      .then((rows) => rows[0] ?? null);
    expect(destAcmeIssue).toBeNull();

    const squatterStillThere = await destDb
      .select()
      .from(issues)
      .where(eq(issues.id, squatterIssueId))
      .then((rows) => rows[0] ?? null);
    expect(squatterStillThere).not.toBeNull();
  }, 60_000);

  it("is idempotent on re-run: second import preserves the first's state without duplicating", async () => {
    // First import: clean seed, fully succeed.
    const seeded = await seedSource();

    const noopStorage = {
      provider: "local_disk",
      putFile: async () => { throw new Error("storage should not be called"); },
      getObject: async () => { throw new Error("storage should not be called"); },
      headObject: async () => { throw new Error("storage should not be called"); },
      deleteObject: async () => { throw new Error("storage should not be called"); },
    } as unknown as StorageService;

    const firstRun = await copyEntitiesViaPortability({
      sourceUrl: sourceTempDb!.connectionString,
      db: destDb,
      storage: noopStorage,
      companyIds: [],
      include: { company: true, agents: true, projects: true, issues: true },
      preserveIds: true,
    });
    expect(firstRun.companies.failed).toBe(0);
    expect(firstRun.failures).toHaveLength(0);

    // Snapshot destination row counts after the first import.
    const countBefore = {
      companies: (await destDb.select().from(companies)).length,
      agents: (await destDb.select().from(agents)).length,
      projects: (await destDb.select().from(projects)).length,
      issues: (await destDb.select().from(issues)).length,
    };
    expect(countBefore.companies).toBe(1);
    expect(countBefore.issues).toBe(1);

    // Second import — same source, same destination. Should be a no-op:
    // company.insertIfMissing skips on uuid collision, downstream entities
    // either skip or update-to-self.
    const secondRun = await copyEntitiesViaPortability({
      sourceUrl: sourceTempDb!.connectionString,
      db: destDb,
      storage: noopStorage,
      companyIds: [],
      include: { company: true, agents: true, projects: true, issues: true },
      preserveIds: true,
    });

    // No throws — failures stays empty.
    expect(secondRun.companies.failed).toBe(0);
    expect(secondRun.failures).toHaveLength(0);

    // Idempotency signal: the importer surfaced "already exists; skipped"
    // warnings on the second pass. We check the substring rather than exact
    // text to stay tolerant of message tweaks.
    expect(
      secondRun.warnings.some((w) => /already exists/i.test(w)),
    ).toBe(true);

    // Row counts unchanged — no duplicate rows by any natural key.
    const countAfter = {
      companies: (await destDb.select().from(companies)).length,
      agents: (await destDb.select().from(agents)).length,
      projects: (await destDb.select().from(projects)).length,
      issues: (await destDb.select().from(issues)).length,
    };
    expect(countAfter).toEqual(countBefore);

    // UUIDs preserved from the source — the second run didn't replace them.
    const finalCompany = await destDb
      .select()
      .from(companies)
      .where(eq(companies.id, seeded.companyId))
      .then((rows) => rows[0] ?? null);
    expect(finalCompany).not.toBeNull();

    const finalIssue = await destDb
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0] ?? null);
    expect(finalIssue).not.toBeNull();
    expect(finalIssue!.identifier).toBe("ACM-42");
  }, 60_000);

  it("mints fresh uuids when preserveIds is false", async () => {
    const seeded = await seedSource();

    const sourcePortability = companyPortabilityService(sourceDb);
    const destPortability = companyPortabilityService(destDb);

    const bundle = await sourcePortability.exportBundle(seeded.companyId, {
      include: { company: true, agents: true, projects: true, issues: true },
    });

    const result = await destPortability.importBundle(
      {
        source: { type: "inline", rootPath: bundle.rootPath, files: bundle.files },
        include: { company: true, agents: true, projects: true, issues: true },
        target: { mode: "new_company", newCompanyName: "Acme Fresh" },
        collisionStrategy: "rename",
      },
      /* actorUserId */ null,
      { preserveIds: false },
    );

    expect(result.company.action).toBe("created");

    // Source uuid should NOT exist at the destination.
    const colliding = await destDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, seeded.companyId))
      .then((rows) => rows[0] ?? null);
    expect(colliding).toBeNull();

    // But a company with a similar name should exist with a fresh uuid.
    const allDestCompanies = await destDb.select().from(companies);
    expect(allDestCompanies).toHaveLength(1);
    expect(allDestCompanies[0].id).not.toBe(seeded.companyId);
  }, 60_000);
});
