import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { Block, BlockResponse, FormBlock } from "@emdash-cms/blocks";
import type { ImportJob } from "../src/model.js";
let host: PluginRuntimeTestHost;
afterEach(async () => { await host?.dispose(); });
async function setup() {
  host = await createPluginRuntimeTestHost();
  await host.fixtures.collection({ slug: "products", label: "Products", supports: ["drafts"], fields: [
    { slug: "name", label: "Name", type: "string", required: true, validation: { pattern: "^Product [AB]$" } },
    { slug: "price", label: "Price", type: "number" },
    { slug: "active", label: "Active", type: "boolean" },
    { slug: "notes", label: "Notes", type: "text" },
    { slug: "body", label: "Body", type: "portableText" },
  ] });
}
const values = (source = "name,price,active\nProduct A,42,true\nProduct B,39.99,false") => ({
  sourceType: "csv", source, collection: "products", map_0: "name", map_1: "price", map_2: "active",
});
function findForm(response: BlockResponse): FormBlock {
  function find(blocks: Block[]): FormBlock | undefined {
    for (const block of blocks) {
      if (block.type === "form") return block;
      if (block.type === "accordion") { const form = find(block.blocks); if (form) return form; }
    }
  }
  const form = find(response.blocks);
  if (!form) throw new Error(JSON.stringify(response));
  return form;
}
const jobs = async () => (await host.inspect.storage.list<ImportJob>("jobs")).map(row => row.data);
async function preview(input = values()) {
  const response = await host.admin.submit("/manage", "preview", input, { blockId: "mapping" });
  expect(response.toast?.type).not.toBe("error");
  return findForm(response).block_id!;
}
describe("official runtime host and production sandbox", () => {
  it("loads custom collections and field metadata in native Block Kit", async () => {
    await setup();
    const initial = await host.admin.loadPage("/manage");
    expect(JSON.stringify(initial)).toContain("New import");
    const fresh = await host.admin.act("/manage", "new");
    expect(JSON.stringify(fresh)).toContain("Products");
    const mapped = await host.admin.submit("/manage", "map", { sourceType: "csv", source: values().source, collection: "products" }, { blockId: "source" });
    expect(findForm(mapped).fields.some(field => field.action_id === "map_0")).toBe(true);
    expect(JSON.stringify(mapped)).toContain("Unsupported in v0.1");
  });
  it("previews without writing and stores no source records", async () => {
    await setup(); await preview();
    expect(await host.inspect.content.list("products")).toEqual([]);
    const job = (await jobs())[0];
    expect(job.status).toBe("pending");
    expect(JSON.stringify(job)).not.toContain("Product A");
    expect(Object.keys(job)).not.toContain("source");
  });
  it("creates drafts, stores counts and shows history", async () => {
    await setup();
    const id = await preview();
    const result = await host.admin.submit("/manage", "execute", values(), { blockId: id });
    expect(result.toast?.type).not.toBe("error");
    const entries = await host.inspect.content.list("products");
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.status === "draft")).toBe(true);
    expect(entries.map(entry => entry.data.price).sort()).toEqual([39.99, 42]);
    expect((await jobs())[0]).toMatchObject({ created: 2, failed: 0, skipped: 0, status: "completed" });
    expect(JSON.stringify(await host.admin.loadPage("/manage"))).toContain("2 created");
  });
  it("imports canonical JSON and ignores unmapped fields", async () => {
    await setup();
    const input = { sourceType: "json", source: '[{"name":"Product A","price":29.99,"unused":"ignored"}]', collection: "products", map_0: "name", map_1: "price", map_2: "" };
    const response = await host.admin.submit("/manage", "preview", input, { blockId: "mapping" });
    await host.admin.submit("/manage", "execute", input, { blockId: findForm(response).block_id });
    expect((await host.inspect.content.list("products"))[0].data).toMatchObject({ name: "Product A", price: 29.99 });
    expect((await host.inspect.content.list("products"))[0].data).not.toHaveProperty("unused");
  });
  it("skips conversion errors and continues after host validation rejects a row", async () => {
    await setup();
    const input = values("name,price,active\nProduct A,42,true\nProduct C,43,false\nBad,not-a-number,true\nProduct B,9,false");
    const id = await preview(input);
    await host.admin.submit("/manage", "execute", input, { blockId: id });
    expect(await host.inspect.content.list("products")).toHaveLength(2);
    expect((await jobs())[0]).toMatchObject({ created: 2, failed: 1, skipped: 1, status: "partial" });
    expect((await jobs())[0].errors).toHaveLength(2);
    expect(JSON.stringify((await jobs())[0].errors)).not.toContain("Product A");
  });
  it("never retries a confirmed job on duplicate submit", async () => {
    await setup(); const id = await preview();
    await host.admin.submit("/manage", "execute", values(), { blockId: id });
    const repeat = await host.admin.submit("/manage", "execute", values(), { blockId: id });
    expect(repeat.toast?.type).toBe("error");
    expect(await host.inspect.content.list("products")).toHaveLength(2);
  });
  it("atomically claims a job when two submits arrive together", async () => {
    await setup(); const id = await preview();
    await Promise.all([
      host.admin.submit("/manage", "execute", values(), { blockId: id }),
      host.admin.submit("/manage", "execute", values(), { blockId: id }),
    ]);
    expect(await host.inspect.content.list("products")).toHaveLength(2);
    expect((await jobs())[0].created).toBe(2);
  });
  it("rejects changes after preview", async () => {
    await setup(); const id = await preview();
    const response = await host.admin.submit("/manage", "execute", { ...values(), source: values().source.replace("42", "420") }, { blockId: id });
    expect(response.toast?.message).toContain("changed");
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
  it("rejects a preview fingerprint mismatch", async () => {
    await setup(); const id = await preview();
    await host.fixtures.plugin.storage("jobs", id, { ...(await jobs())[0], fingerprint: "different-schema" });
    const response = await host.admin.submit("/manage", "execute", values(), { blockId: id });
    expect(response.toast?.type).toBe("error");
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
  it.each([
    { sourceType: "csv", source: "name\nA", collection: "missing" },
    { ...values(), map_0: "body" }, { ...values(), map_1: "name" },
    { ...values(), unexpected: "bad" }, { ...values(), map_1: { bad: true } },
  ])("rejects invalid collections, mappings and malformed admin inputs", async input => {
    await setup();
    const response = await host.admin.submit("/manage", "preview", input, { blockId: "mapping" });
    expect(response.toast?.type).toBe("error");
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
  it("requires a preview job before writes", async () => {
    await setup();
    expect((await host.admin.submit("/manage", "execute", values(), { blockId: crypto.randomUUID() })).toast?.type).toBe("error");
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
  it("preserves source and mapping when a duplicate destination is rejected", async () => {
    await setup();
    const input = { ...values(), map_1: "name" };
    const response = await host.admin.submit("/manage", "preview", input, { blockId: "mapping" });
    expect(response.toast?.message).toContain("only once");
    expect(findForm(response).fields.find(field => field.action_id === "source")).toHaveProperty("initial_value", input.source);
    expect(findForm(response).fields.find(field => field.action_id === "map_1")).toHaveProperty("initial_value", "name");
    expect(await jobs()).toEqual([]);
  });
  it("handles 30 fields and nearly 48 KiB within Block Kit's response budget", async () => {
    await setup();
    const keys = Array.from({ length: 30 }, (_, i) => "field_" + i);
    await host.fixtures.collection({ slug: "wide", label: "Wide", fields: keys.map(slug => ({ slug, label: slug, type: "string" as const })) });
    const input = { sourceType: "csv", collection: "wide", source: keys.join(",") + "\n" + ["\t".repeat(47_000), ...keys.slice(1).map(() => "value")].join(","), ...Object.fromEntries(keys.map((key, i) => ["map_" + i, key])) };
    const mapped = await host.admin.submit("/manage", "map", { sourceType: input.sourceType, source: input.source, collection: input.collection }, { blockId: "source" });
    expect(findForm(mapped).fields.find(field => field.action_id === "map_0")?.type).toBe("text_input");
    const response = await host.admin.submit("/manage", "preview", input, { blockId: "mapping" });
    expect(response.toast?.type).not.toBe("error");
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(256 * 1024);
    expect(await host.inspect.content.list("wide")).toEqual([]);
  });
  it("creates the full supported 100-row batch as drafts", async () => {
    await setup();
    const input = values("name,price,active\n" + Array.from({ length: 100 }, (_, i) => `Product A,${i},true`).join("\n"));
    const id = await preview(input);
    await host.admin.submit("/manage", "execute", input, { blockId: id });
    expect(await host.inspect.content.list("products")).toHaveLength(100);
    expect((await jobs())[0]).toMatchObject({ created: 100, status: "completed" });
  }, 30_000);
  it("cancels previews and clears history without deleting entries", async () => {
    await setup(); const id = await preview();
    await host.admin.act("/manage", "cancel", { value: id });
    expect((await jobs())[0].status).toBe("cancelled");
    expect((await host.admin.submit("/manage", "execute", values(), { blockId: id })).toast?.type).toBe("error");
    await host.admin.act("/manage", "delete", { value: id });
    expect(await jobs()).toEqual([]);
  });
  it("caps history and expires old previews without dataset retention", async () => {
    await setup(); const id = await preview();
    const job = (await jobs())[0];
    for (let i = 0; i < 55; i++) {
      const newId = crypto.randomUUID();
      await host.fixtures.plugin.storage("jobs", newId, { ...job, id: newId, startedAt: new Date(Date.now() - (i + 60) * 60_000).toISOString() });
    }
    await host.admin.loadPage("/manage");
    expect(await jobs()).toHaveLength(50);
    expect((await jobs()).filter(job => job.id !== id).every(job => job.status === "expired")).toBe(true);
  });
  it("declares only schema read and content write with a private bounded POST route", async () => {
    await setup();
    // The host expands content:write to its implied content:read capability.
    expect(host.manifest.capabilities).toEqual(["content:read", "content:write", "schema:read"]);
    expect(host.manifest.allowedHosts).toEqual([]);
    const result = await host.actions.routes.request("admin", { method: "GET", headers: { "X-EmDash-Request": "1" }, user: { id: "admin", email: "admin@example.invalid", name: "Admin", role: 50, createdAt: new Date().toISOString() } });
    expect(result.status).toBe(405);
  });
  it("rejects unauthenticated route requests without writes", async () => {
    await setup();
    const result = await host.actions.routes.request("admin", { method: "POST", body: { type: "form_submit", action_id: "preview", values: values() } });
    expect(result.status).toBe(401);
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
  it("rejects non-admin users and oversized route bodies", async () => {
    await setup();
    const user = { id: "review-user", email: "review@example.invalid", name: "Review", role: 20, createdAt: new Date().toISOString() };
    const denied = await host.actions.routes.request("admin", { method: "POST", headers: { "X-EmDash-Request": "1" }, user, body: { type: "page_load", page: "/manage" } });
    expect(denied.status).toBe(403);
    const oversized = await host.actions.routes.request("admin", { method: "POST", headers: { "X-EmDash-Request": "1" }, user: { ...user, role: 50 }, body: { type: "form_submit", action_id: "preview", values: { ...values(), source: "x".repeat(256 * 1024) } } });
    expect(oversized.status).toBe(413);
    expect(await host.inspect.content.list("products")).toEqual([]);
  });
});
