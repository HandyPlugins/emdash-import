import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";
import { parseCsv, parseJson } from "../src/sources.js";
import { convert, prepare, writable } from "../src/mapping.js";
import { MAX_SOURCE_BYTES, type CollectionSchemaInfo, type FieldSchemaInfo, type ImportJob, type Plan } from "../src/model.js";
import { execute, fingerprint } from "../src/jobs.js";
export const field = (slug: string, type: FieldSchemaInfo["type"], extra: Partial<FieldSchemaInfo> = {}): FieldSchemaInfo => ({
  slug, label: slug, type, required: false, unique: false, searchable: false, indexed: false, translatable: true, sortOrder: 0, ...extra,
});
describe("execution interruption boundaries", () => {
  async function checkpointContext(plan: Plan, failCheckpoint: boolean, onCreate?: () => void) {
    let saved: ImportJob = {
      id: crypto.randomUUID(), owner: "admin", sourceType: plan.sourceType, collection: plan.collection,
      mode: "create", status: "pending", totalRows: 3, created: 0, updated: 0, skipped: 0, failed: 0,
      startedAt: new Date().toISOString(), fingerprint: await fingerprint(plan, schema), schemaVersion: 1, errors: [],
    };
    const create = vi.fn(async () => { onCreate?.(); return { id: crypto.randomUUID() }; });
    const ctx = {
      content: { create },
      storage: { jobs: {
        getVersioned: async () => ({ value: structuredClone(saved), revision: 1 }),
        compareAndSet: async (_id: string, _revision: number, value: ImportJob) => { saved = structuredClone(value); return { applied: true }; },
        put: async (_id: string, value: ImportJob) => { if (failCheckpoint) throw new Error("checkpoint unavailable"); saved = structuredClone(value); },
        query: async () => ({ items: [{ id: saved.id, data: structuredClone(saved) }] }),
      } },
    } as unknown as PluginContext;
    return { ctx, create, saved: () => structuredClone(saved) };
  }
  const plan: Plan = { sourceType: "csv", collection: "products", source: "name\nA\nB\nC", mapping: { name: "name" } };
  it("prevents replay when content succeeds but its checkpoint fails", async () => {
    const state = await checkpointContext(plan, true);
    const rows = prepare(parseCsv(plan.source), schema, plan.mapping);
    await expect(execute(state.ctx, "admin", state.saved().id, plan, schema, rows)).rejects.toThrow("checkpoint unavailable");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.saved()).toMatchObject({ status: "running", created: 0 });
    await expect(execute(state.ctx, "admin", state.saved().id, plan, schema, rows)).rejects.toThrow("already been started");
    expect(state.create).toHaveBeenCalledTimes(1);
  });
  it("stops starting rows after the deadline and reports remaining rows as skipped", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const state = await checkpointContext(plan, false, () => { now += 20_001; });
      const rows = prepare(parseCsv(plan.source), schema, plan.mapping);
      const result = await execute(state.ctx, "admin", state.saved().id, plan, schema, rows);
      expect(state.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "partial", created: 1, skipped: 2, failed: 0 });
      expect(result.errors[0].message).toContain("budget reached");
    } finally { clock.mockRestore(); }
  });
});
export const schema: CollectionSchemaInfo = {
  slug: "products", label: "Products", labelSingular: "Product", description: null,
  supports: ["drafts"], hasSeo: false, titleField: "name", dateField: null, urlPattern: null, routable: false, hidden: false,
  fields: [field("name", "string", { required: true }), field("price", "number"), field("count", "integer"), field("active", "boolean"), field("date", "datetime"), field("notes", "text"), field("kind", "select", { validation: { options: ["book", "tool"] } }), field("body", "portableText")],
};
describe("source parsing", () => {
  it("reads CSV headers, UTF-8, CRLF, empty cells and BOM", () => {
    expect(parseCsv("\uFEFFname,price\r\nCafé,42\r\nEmpty,\r\n").rows).toEqual([{ name: "Café", price: "42" }, { name: "Empty", price: "" }]);
  });
  it("reads quoted commas, escaped quotes and embedded newlines", () => {
    expect(parseCsv('name,notes\n"Product, A","He said ""hello""\nand left"').rows[0]).toEqual({ name: "Product, A", notes: 'He said "hello"\nand left' });
  });
  it.each(['name,price\n"unterminated,42', "name,price\nA,42,extra", "name,name\nA,B", "name,\nA,B"])("rejects malformed CSV %s", input => expect(() => parseCsv(input)).toThrow());
  it("preserves formula-looking values as inert text", () => expect(parseCsv("name\n=1+1").rows[0].name).toBe("=1+1"));
  it("rejects literal control characters that cannot fit a safe Block Kit echo", () => {
    expect(() => parseCsv("name\n" + "\x00".repeat(100))).toThrow("control characters");
    expect(parseCsv("name,notes\nA,tab\tvalue").rows[0].notes).toBe("tab\tvalue");
  });
  it("accepts flat JSON arrays, scalars, nulls and unioned keys", () => {
    const parsed = parseJson('[{"name":"A","active":false},{"name":"B","price":42,"notes":null}]');
    expect(parsed.columns).toEqual(["name", "active", "price", "notes"]);
    expect(parsed.rows[0].active).toBe(false);
  });
  it.each(["{", '{"items":[]}', "null", "[1]", "[]", '[{"name":{"nested":true}}]', '[{"name":["A"]}]', '[{"__proto__":"A"}]', '[{"constructor":"A"}]'])("rejects invalid JSON %s", input => expect(() => parseJson(input)).toThrow());
  it("rejects oversized UTF-8, rows and columns", () => {
    expect(() => parseCsv("name\n" + "é".repeat(MAX_SOURCE_BYTES / 2))).toThrow("48 KiB");
    expect(() => parseCsv("name\n" + Array(101).fill("A").join("\n"))).toThrow("100");
    expect(() => parseJson(JSON.stringify([Object.fromEntries(Array.from({ length: 31 }, (_, i) => ["k" + i, i]))]))).toThrow("30");
  });
});
describe("mapping and conversion", () => {
  it("maps, ignores, converts and omits empty optional cells", () => {
    const rows = prepare(parseCsv("name,price,other,notes\nA,42,ignore,"), schema, { name: "name", price: "price", other: "", notes: "notes" });
    expect(rows[0]).toEqual({ row: 1, data: { name: "A", price: 42 }, errors: [] });
  });
  it("rejects duplicate destinations, unknown fields and unsupported mappings", () => {
    const source = parseCsv("a,b\nA,B");
    for (const mapping of [{ a: "name", b: "name" }, { a: "missing", b: "" }, { a: "body", b: "" }])
      expect(() => prepare(source, schema, mapping)).toThrow();
  });
  it("requires complete mappings and at least one destination", () => {
    expect(() => prepare(parseCsv("name\nA"), schema, {})).toThrow();
    expect(() => prepare(parseCsv("name\nA"), schema, { name: "" })).toThrow();
  });
  it.each([["number", "42", 42], ["integer", "-4", -4], ["boolean", "false", false], ["boolean", true, true], ["datetime", "2026-10-07T12:00:00+03:00", "2026-10-07T09:00:00.000Z"], ["text", "<b>literal</b>", "<b>literal</b>"]] as const)("converts %s explicitly", (type, value, expected) => expect(convert(value, field("value", type))).toBe(expected));
  it.each([["number", "1,000"], ["number", "   "], ["number", "0x20"], ["integer", "1.5"], ["integer", "9007199254740992"], ["boolean", "yes"], ["boolean", "1"], ["datetime", "2026-02-30T00:00:00Z"], ["datetime", "2026-10-07"], ["datetime", "2026-10-07T24:00:00Z"], ["string", 42]] as const)("rejects ambiguous %s %s", (type, value) => expect(() => convert(value, field("value", type))).toThrow());
  it("validates required values, supported defaults and bounds", () => {
    expect(prepare(parseCsv("name\n "), schema, { name: "name" })[0].errors).toEqual([]);
    expect(prepare(parseJson('[{"name":null}]'), schema, { name: "name" })[0].errors).toContain("name: required value is missing.");
    expect(prepare(parseJson('[{"name":null}]'), { ...schema, fields: [field("name", "string", { required: true, default: "Default" })] }, { name: "name" })[0].data.name).toBe("Default");
    expect(() => convert("5", field("price", "number", { validation: { min: 10 } }))).toThrow();
    expect(() => convert("abc", field("name", "text", { validation: { maxLength: 2 } }))).toThrow();
  });
  it("rejects unavailable select choices and reserves identity/status fields", () => {
    expect(convert("book", schema.fields[6])).toBe("book");
    expect(() => convert("Book", schema.fields[6])).toThrow();
    expect(writable(field("status", "string"))).toBe(false);
    expect(writable(field("custom", "string", { widget: "other:custom" }))).toBe(false);
    expect(writable(field("choice", "select"))).toBe(false);
  });
  it("shows required unsupported fields before writes", () => {
    const rows = prepare(parseCsv("name\nA"), { ...schema, fields: [...schema.fields, field("image", "image", { required: true })] }, { name: "name" });
    expect(rows[0].errors.join(" ")).toContain("unsupported");
  });
  it("binds a preview fingerprint to source, mapping and the current schema", async () => {
    const plan = { sourceType: "csv" as const, source: "name\nA", collection: "products", mapping: { name: "name" } };
    const before = await fingerprint(plan, schema);
    expect(await fingerprint(plan, schema)).toBe(before);
    expect(await fingerprint(plan, { ...schema, fields: [...schema.fields, field("new_required", "string", { required: true })] })).not.toBe(before);
    expect(await fingerprint({ ...plan, mapping: { name: "notes" } }, schema)).not.toBe(before);
  });
});
