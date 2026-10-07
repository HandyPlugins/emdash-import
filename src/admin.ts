import * as z from "zod/mini";
import type { Block, BlockResponse, ButtonElement, FormField } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import type { CollectionSchemaInfo } from "./model.js";
import { collections, collection, prepare, writable } from "./mapping.js";
import { createPreview, execute, prune } from "./jobs.js";
import { InputError, JobSchema, MAX_SOURCE_BYTES, PREVIEW_ROWS, sourceTypes, type ImportJob, type Plan, type PreparedRow, type Source } from "./model.js";
import { parseSource } from "./sources.js";

const interaction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_load"), page: z.literal("/manage") }),
  z.object({ type: z.literal("block_action"), action_id: z.enum(["new", "list", "results", "cancel", "delete"]), value: z.optional(z.string().check(z.maxLength(100))), block_id: z.optional(z.string().check(z.maxLength(100))), page: z.optional(z.string().check(z.maxLength(200))) }),
  z.object({ type: z.literal("form_submit"), action_id: z.enum(["map", "preview", "execute"]), block_id: z.optional(z.string().check(z.maxLength(100))), values: z.record(z.string(), z.unknown()), page: z.optional(z.string().check(z.maxLength(200))) }),
]);
const sourceForm = z.object({
  sourceType: z.enum(sourceTypes), source: z.string().check(z.minLength(1), z.maxLength(MAX_SOURCE_BYTES)),
  collection: z.string().check(z.regex(/^[a-z][a-z0-9_]{0,62}$/)),
});
const button = (action_id: string, label: string, value?: string): ButtonElement =>
  ({ type: "button", action_id, label, ...(value ? { value } : {}) });
const home: Block = { type: "actions", elements: [button("list", "Recent imports"), button("new", "New import")] };
const failure = (message: string): BlockResponse => ({
  blocks: [{ type: "header", text: "Import" }, { type: "section", text: message }, home],
  toast: { type: "error", message },
});
const short = (value: unknown, length = 200): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length <= length ? text : text.slice(0, length) + "…";
};
function sourceFields(plan?: Pick<Plan, "sourceType" | "source" | "collection">, options: { label: string; value: string }[] = []): FormField[] {
  return [
    { type: "select", action_id: "sourceType", label: "Source format", options: sourceTypes.map(value => ({ label: value.toUpperCase(), value })), initial_value: plan?.sourceType ?? "csv" },
    { type: "text_input", action_id: "source", label: "Paste data (up to 48 KiB UTF-8)", multiline: true, placeholder: "name,price\nProduct A,29.99", initial_value: plan?.source ?? "" },
    { type: "select", action_id: "collection", label: "Destination collection", options, ...(plan?.collection && options.some(option => option.value === plan.collection) ? { initial_value: plan.collection } : {}) },
  ];
}
async function newImport(ctx: PluginContext, initial?: Pick<Plan, "sourceType" | "source" | "collection">): Promise<BlockResponse> {
  const schemas = await collections(ctx);
  if (!schemas.length) return failure("No writable collections are available. Add a collection with supported scalar fields in EmDash.");
  return { blocks: [
    { type: "header", text: "New import" },
    { type: "section", text: "Import CSV or a flat JSON array into an existing collection. Entries are created as drafts." },
    { type: "context", text: "Up to 100 rows and 30 source fields. CSV needs a header row. JSON needs an array of flat objects. File upload is unavailable in sandboxed Block Kit." },
    ...(schemas.length > 100 ? [{ type: "context" as const, text: "More than 100 collections are available. Enter the destination collection slug from EmDash's collection settings." }] : []),
    { type: "form", block_id: "source", fields: sourceFields(initial, schemas.length <= 100 ? schemas.map(schema => ({ label: short(schema.label), value: schema.slug })) : []).map(field => field.action_id === "collection" && schemas.length > 100
      ? { type: "text_input" as const, action_id: "collection", label: "Destination collection slug", initial_value: initial?.collection ?? "" } : field), submit: { action_id: "map", label: "Map fields" } },
    home,
  ] };
}
function mappingFields(plan: Plan, source: Source, schema: CollectionSchemaInfo): FormField[] {
  const fields = schema.fields.filter(writable);
  const options = [{ label: "Ignore this field", value: "" }, ...fields.map(field => ({
    label: `${field.label} (${field.type})${field.required || field.validation?.required ? " — required" : ""}`, value: field.slug,
  }))];
  // Large matrices exceed Block Kit's 2,000-node response budget. The native
  // text form remains usable with the displayed field-slug reference.
  const useSelect = options.length * source.columns.length <= 300;
  return source.columns.map((key, i) => {
    const candidate = plan.mapping[key] ?? (fields.find(field => field.slug.toLowerCase() === key.toLowerCase() || field.label.toLowerCase() === key.toLowerCase())?.slug ?? "");
    const initial_value = !useSelect || options.some(option => option.value === candidate) ? candidate : "";
    return useSelect
      ? { type: "select", action_id: `map_${i}`, label: `${key} → destination`, options, initial_value }
      : { type: "text_input", action_id: `map_${i}`, label: `${key} → field slug (empty = ignore)`, initial_value };
  });
}
function planForm(plan: Plan, source: Source, schema: CollectionSchemaInfo, action: "preview" | "execute", id: string): Block {
  return {
    type: "form", block_id: id,
    fields: [...sourceFields(plan, [{ label: schema.label, value: schema.slug }]), ...mappingFields(plan, source, schema)],
    submit: { action_id: action, label: action === "preview" ? "Preview import" : "Import valid rows as drafts" },
  };
}
function mappingScreen(plan: Plan, source: Source, schema: CollectionSchemaInfo): BlockResponse {
  return { blocks: [
    { type: "header", text: "Map fields" },
    { type: "section", text: `${source.rows.length} data ${source.rows.length === 1 ? "row" : "rows"} parsed. Map each source field or ignore it. Each destination can be used once.` },
    { type: "context", text: "Empty cells/null values use scalar defaults where available; otherwise they are omitted. Required fields must have a value. true/false are the only accepted boolean strings." },
    ...(schema.fields.length > 100 ? [{ type: "context" as const, text: "The first 100 destination fields are listed below. Other supported fields can still be mapped by their exact field slug." }] : []),
    { type: "table", page_action_id: "list", columns: [{ key: "label", label: "Destination field" }, { key: "slug", label: "Field slug" }, { key: "type", label: "Type" }, { key: "required", label: "Required" }, { key: "support", label: "Support" }],
      rows: schema.fields.slice(0, 100).map(field => ({ label: short(field.label), slug: field.slug, type: field.type, required: field.required || field.validation?.required ? "Yes" : "No", support: writable(field) ? "Supported" : "Unsupported in v0.1" })) },
    planForm(plan, source, schema, "preview", "mapping"), home,
  ] };
}
function previewScreen(job: ImportJob, plan: Plan, source: Source, schema: CollectionSchemaInfo, rows: PreparedRow[]): BlockResponse {
  const invalid = rows.filter(row => row.errors.length);
  return { blocks: [
    { type: "header", text: "Preview import" },
    { type: "section", text: `Ready to create: ${rows.length - invalid.length}. Invalid rows to skip: ${invalid.length}. Destination: ${schema.label}. Nothing has been written.` },
    { type: "table", page_action_id: "list", columns: [{ key: "row", label: "Data row" }, { key: "status", label: "Validation" }, { key: "data", label: "Converted values" }, { key: "error", label: "Issues" }],
      rows: rows.slice(0, PREVIEW_ROWS).map(row => ({ row: row.row, status: row.errors.length ? "Will skip" : "Valid", data: short(JSON.stringify(row.data), 3000), error: short(row.errors.join(" "), 1000) })) },
    { type: "context", text: "First 8 rows shown; long values are shortened for display. Every row was validated. Host unique constraints, regex rules and save hooks can still reject writes. Preview expires after 30 minutes." },
    ...(invalid.length ? [{ type: "table" as const, page_action_id: "list", columns: [{ key: "row", label: "Invalid data row" }, { key: "error", label: "Issues (first 20 invalid rows)" }], rows: invalid.slice(0, 20).map(row => ({ row: row.row, error: short(row.errors.join(" "), 1000) })) }] : []),
    ...(rows.some(row => !row.errors.length) ? [
      { type: "context" as const, text: "Confirm using the reviewed source and mapping below. If you change them, return to mapping and preview again. Source data stays in this form and is never stored in plugin history." },
      { type: "accordion" as const, label: "Confirm reviewed data and mapping", default_open: true, blocks: [planForm(plan, source, schema, "execute", job.id)] },
    ] : []),
    { type: "actions", elements: [button("cancel", "Cancel preview", job.id), button("new", "Start over"), button("list", "Recent imports")] },
  ] };
}
function resultScreen(job: ImportJob): BlockResponse {
  return { blocks: [
    { type: "header", text: "Import results" },
    { type: "section", text: `${job.status} — ${job.collection} (${job.sourceType.toUpperCase()})` },
    { type: "fields", fields: [{ label: "Created drafts", value: String(job.created) }, { label: "Updated", value: "0" }, { label: "Skipped", value: String(job.skipped) }, { label: "Failed writes", value: String(job.failed) }, { label: "Total rows", value: String(job.totalRows) }] },
    ...(job.status === "running" ? [{ type: "section" as const, text: "This import is running or was interrupted. Counts reflect the last saved checkpoint. Do not repeat it without checking the collection; a write may have completed after the checkpoint. Automatic retry is disabled." }] : []),
    ...(job.status === "pending" ? [{ type: "context" as const, text: "Preview awaiting confirmation. Source data is not stored, so a reloaded page cannot resume it. Cancel this preview and start again." }] : []),
    { type: "table", page_action_id: "list", empty_text: "No recorded issues.", columns: [{ key: "row", label: "Data row" }, { key: "message", label: "Issue (up to 20 retained)" }], rows: job.errors },
    home,
  ] };
}
async function list(ctx: PluginContext): Promise<BlockResponse> {
  await prune(ctx);
  const records = await ctx.storage.jobs.query({ orderBy: { startedAt: "desc" }, limit: 50 });
  return { blocks: [
    { type: "header", text: "Import" },
    { type: "section", text: "Import structured data into EmDash collections." }, home,
    { type: "context", text: "Showing the latest 50 jobs. History retains counts and up to 20 concise issues, never source records. Latest 50 results/previews are retained; active jobs are preserved." },
    { type: "table", page_action_id: "list", empty_text: "No imports yet. Choose New import to get started.",
      columns: [{ key: "date", label: "Date", format: "relative_time" }, { key: "source", label: "Source" }, { key: "collection", label: "Collection" }, { key: "status", label: "Status", format: "badge" }, { key: "counts", label: "Result" }, { key: "view", label: "Details", format: "element" }, { key: "remove", label: "Clear", format: "element" }],
      rows: records.items.flatMap(record => {
        const parsed = JobSchema.safeParse(record.data);
        if (!parsed.success) return [];
        const job = parsed.data;
        return [{ date: job.startedAt, source: job.sourceType.toUpperCase(), collection: job.collection, status: job.status, counts: `${job.created} created · ${job.skipped} skipped · ${job.failed} failed`,
          view: button("results", "View", job.id),
          ...(job.status !== "running" ? { remove: { ...button("delete", "Clear", job.id), confirm: { title: "Clear import history?", text: "This removes this result or pending preview. Created content is preserved.", confirm: "Clear", deny: "Cancel" } } } : {}),
        }];
      }) },
  ] };
}
export async function handleAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  if (!route.user || route.user.role < 50) return failure("Only site administrators can import content.");
  const parsed = interaction.safeParse(route.input);
  if (!parsed.success) return failure("Invalid admin request.");
  const input = parsed.data;
  let recovery: BlockResponse | undefined;
  let recoverSource: Pick<Plan, "sourceType" | "source" | "collection"> | undefined;
  try {
    if (input.type === "page_load") return await list(ctx);
    if (input.type === "block_action") {
      if (input.action_id === "new") return await newImport(ctx);
      if (input.action_id === "list") return await list(ctx);
      if (!z.uuid().safeParse(input.value).success) throw new InputError("Invalid import job ID.");
      const id = input.value!;
      const versioned = await ctx.storage.jobs.getVersioned(id);
      const stored = JobSchema.safeParse(versioned?.value);
      if (!versioned || !stored.success) throw new InputError("Import history is unavailable.");
      if (input.action_id === "results") return resultScreen(stored.data);
      if (input.action_id === "cancel") {
        if (stored.data.owner !== route.user.id || stored.data.status !== "pending") throw new InputError("This preview cannot be cancelled.");
        await ctx.storage.jobs.compareAndSet(id, versioned.revision, { ...stored.data, status: "cancelled", completedAt: new Date().toISOString() });
      } else {
        if (stored.data.status === "running") throw new InputError("An active or interrupted import cannot be cleared while its outcome is uncertain.");
        await ctx.storage.jobs.compareAndDelete(id, versioned.revision);
      }
      return await list(ctx);
    }
    const base = sourceForm.safeParse(input.values);
    if (!base.success) throw new InputError("Select CSV/JSON, paste data within 48 KiB, and choose a collection.");
    // Echo only bounded, display-safe text when recovering a rejected form.
    if (new TextEncoder().encode(base.data.source).byteLength <= MAX_SOURCE_BYTES && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(base.data.source)) recoverSource = base.data;
    const source = parseSource(base.data.sourceType, base.data.source);
    const schema = await collection(ctx, base.data.collection);
    const mapping: Record<string, string> = {};
    const allowed = new Set(["sourceType", "source", "collection"]);
    source.columns.forEach((key, i) => {
      allowed.add(`map_${i}`);
      if (input.action_id !== "map") {
        const value = input.values[`map_${i}`];
        if (typeof value !== "string" || value.length > 63) throw new InputError("Invalid field mapping.");
        mapping[key] = value;
      }
    });
    if (Object.keys(input.values).some(key => !allowed.has(key))) throw new InputError("Unexpected form fields.");
    const plan: Plan = { ...base.data, mapping };
    recovery = mappingScreen(plan, source, schema);
    if (input.action_id === "map") return mappingScreen(plan, source, schema);
    const rows = prepare(source, schema, mapping);
    if (input.action_id === "preview") {
      const job = await createPreview(ctx, route.user.id, plan, schema, rows);
      return previewScreen(job, plan, source, schema, rows);
    }
    if (!z.uuid().safeParse(input.block_id).success) throw new InputError("Import requires a valid preview.");
    return resultScreen(await execute(ctx, route.user.id, input.block_id!, plan, schema, rows));
  } catch (error) {
    const message = error instanceof InputError ? error.message : "Import could not complete. Open Recent imports and verify the collection before retrying. Check site logs for details.";
    if (error instanceof InputError) {
      if (!recovery && recoverSource) {
        try { recovery = await newImport(ctx, recoverSource); } catch { /* Keep the original validation error if schema access also fails. */ }
      }
      if (recovery) return { ...recovery, toast: { type: "error", message } };
    }
    return failure(message);
  }
}
