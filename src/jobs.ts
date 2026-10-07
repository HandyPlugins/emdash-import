import type { PluginContext } from "emdash/plugin";
import type { CollectionSchemaInfo } from "./model.js";
import { EXECUTION_BUDGET_MS, InputError, JobSchema, MAX_ERRORS, MAX_HISTORY, PREVIEW_TTL_MS, type ImportJob, type Plan, type PreparedRow } from "./model.js";
export async function fingerprint(plan: Plan, schema: CollectionSchemaInfo): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    sourceType: plan.sourceType, source: plan.source, collection: plan.collection,
    mapping: Object.entries(plan.mapping).sort(([a], [b]) => a.localeCompare(b)), schema,
  }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function prune(ctx: PluginContext): Promise<void> {
  const records = await ctx.storage.jobs.query({ orderBy: { startedAt: "desc" }, limit: 100 });
  for (const record of records.items) {
    const parsed = JobSchema.safeParse(record.data);
    if (!parsed.success) continue;
    const job = parsed.data;
    if (job.status === "pending" && Date.now() - Date.parse(job.startedAt) > PREVIEW_TTL_MS) {
      const versioned = await ctx.storage.jobs.getVersioned(job.id);
      if (versioned && JobSchema.parse(versioned.value).status === "pending")
        await ctx.storage.jobs.compareAndSet(job.id, versioned.revision, { ...job, status: "expired", completedAt: new Date().toISOString() });
    }
  }
  const removable = records.items.filter(row => JobSchema.safeParse(row.data).data?.status !== "running");
  for (const row of removable.slice(MAX_HISTORY)) {
    const current = await ctx.storage.jobs.getVersioned(row.id);
    if (current && JobSchema.safeParse(current.value).data?.status !== "running")
      await ctx.storage.jobs.compareAndDelete(row.id, current.revision);
  }
}
export async function createPreview(ctx: PluginContext, owner: string, plan: Plan, schema: CollectionSchemaInfo, rows: PreparedRow[]): Promise<ImportJob> {
  await prune(ctx);
  if (await ctx.storage.jobs.count() >= 100) throw new InputError("Too many active or retained jobs. Review and clear old results first.");
  const job: ImportJob = {
    id: crypto.randomUUID(), owner, sourceType: plan.sourceType, collection: plan.collection, mode: "create",
    status: "pending", totalRows: rows.length, created: 0, updated: 0, skipped: 0, failed: 0,
    startedAt: new Date().toISOString(), fingerprint: await fingerprint(plan, schema), schemaVersion: 1, errors: [],
  };
  await ctx.storage.jobs.put(job.id, job);
  await prune(ctx);
  return job;
}
function addError(job: ImportJob, row: number, message: string): void {
  if (job.errors.length < MAX_ERRORS) job.errors.push({ row, message: message.slice(0, 300) });
}
export async function execute(ctx: PluginContext, owner: string, id: string, plan: Plan, schema: CollectionSchemaInfo, rows: PreparedRow[]): Promise<ImportJob> {
  const versioned = await ctx.storage.jobs.getVersioned(id);
  const parsed = JobSchema.safeParse(versioned?.value);
  if (!versioned || !parsed.success || parsed.data.owner !== owner) throw new InputError("This preview is unavailable. Create a new import.");
  const job = parsed.data;
  if (job.status !== "pending") throw new InputError("This import has already been started or closed. Open its results.");
  if (Date.now() - Date.parse(job.startedAt) > PREVIEW_TTL_MS) throw new InputError("The preview expired after 30 minutes. Preview the data again.");
  if (job.fingerprint !== await fingerprint(plan, schema)) throw new InputError("The source, mapping, or collection schema changed. Preview the data again before importing.");
  if (!ctx.content?.create) throw new InputError("Content write access is unavailable. Check Import's granted permissions.");
  job.status = "running"; job.startedAt = new Date().toISOString();
  const claimed = await ctx.storage.jobs.compareAndSet(id, versioned.revision, job);
  if (!claimed.applied) throw new InputError("Another request already started this import. Open its results.");
  const started = Date.now();
  for (const row of rows) {
    if (Date.now() - started >= EXECUTION_BUDGET_MS) {
      job.skipped += rows.length - row.row + 1;
      addError(job, row.row, "Execution budget reached. Remaining rows were not attempted; import those rows separately."); break;
    }
    if (row.errors.length) { job.skipped++; addError(job, row.row, row.errors.join(" ")); }
    else {
      try { await ctx.content.create(plan.collection, row.data); job.created++; }
      catch {
        job.failed++;
        addError(job, row.row, "Host write failed. Check collection validation, unique values, and site logs. Verify content before retrying this row.");
      }
    }
    // Content and storage cannot commit atomically. Stop on a storage error;
    // 'running' indicates uncertainty and prevents automatic duplicate writes.
    await ctx.storage.jobs.put(id, job);
  }
  job.status = job.created === rows.length ? "completed" : job.created ? "partial" : "failed";
  job.completedAt = new Date().toISOString();
  await ctx.storage.jobs.put(id, job); await prune(ctx); return job;
}
