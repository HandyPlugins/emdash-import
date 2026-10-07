import * as z from "zod/mini";
import type { PluginContext } from "emdash/plugin";
export type CollectionSchemaInfo = NonNullable<Awaited<ReturnType<NonNullable<PluginContext["schema"]>["getCollection"]>>>;
export type FieldSchemaInfo = CollectionSchemaInfo["fields"][number];
export const MAX_SOURCE_BYTES = 48 * 1024;
export const MAX_ROWS = 100;
export const MAX_FIELDS = 30;
export const MAX_HISTORY = 50;
export const MAX_ERRORS = 20;
export const PREVIEW_ROWS = 8;
export const EXECUTION_BUDGET_MS = 20_000;
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const sourceTypes = ["csv", "json"] as const;
export type SourceType = typeof sourceTypes[number];
export type Scalar = string | number | boolean | null;
export type Source = { columns: string[]; rows: Record<string, Scalar>[] };
export type Mapping = Record<string, string>;
export type PreparedRow = { row: number; data: Record<string, Scalar>; errors: string[] };
export type Plan = { sourceType: SourceType; source: string; collection: string; mapping: Mapping };
export const JobSchema = z.object({
  id: z.uuid(), owner: z.string(), sourceType: z.enum(sourceTypes),
  collection: z.string(), mode: z.literal("create"),
  status: z.enum(["pending", "running", "completed", "partial", "failed", "cancelled", "expired"]),
  totalRows: z.int().check(z.gte(0)), created: z.int().check(z.gte(0)),
  updated: z.literal(0), skipped: z.int().check(z.gte(0)), failed: z.int().check(z.gte(0)),
  startedAt: z.string(), completedAt: z.optional(z.string()),
  fingerprint: z.string(), schemaVersion: z.literal(1),
  errors: z.array(z.object({ row: z.int(), message: z.string().check(z.maxLength(300)) })).check(z.maxLength(MAX_ERRORS)),
});
export type ImportJob = z.infer<typeof JobSchema>;
export class InputError extends Error {}
export const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
export function safeKey(key: string): boolean {
  return key.length > 0 && key.length <= 80 && !dangerousKeys.has(key);
}
export function checkSourceSize(text: string): void {
  if (!text.trim()) throw new InputError("Paste CSV or a JSON array to continue.");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new InputError("Source text contains unsupported control characters. Only tabs and line endings are allowed.");
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_BYTES)
    throw new InputError("Source data exceeds 48 KiB of UTF-8 text. Split it into smaller imports.");
}
