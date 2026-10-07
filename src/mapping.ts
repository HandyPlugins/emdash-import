import type { PluginContext } from "emdash/plugin";
import type { CollectionSchemaInfo, FieldSchemaInfo } from "./model.js";
import { InputError, safeKey, type Mapping, type PreparedRow, type Scalar, type Source } from "./model.js";
export const supportedTypes = ["string", "text", "number", "integer", "boolean", "datetime", "select"] as const;
const reservedFields = new Set(["id", "slug", "status", "locale", "seo", "_rev", "created_at", "updated_at", "published_at", "scheduled_at", "author_id", "translation_group_id", "live_revision_id"]);
export function writable(field: FieldSchemaInfo): boolean {
  return supportedTypes.some(type => type === field.type) && !field.widget && safeKey(field.slug) && !reservedFields.has(field.slug)
    && (field.type !== "select" || !!field.validation?.options?.length);
}
export async function collections(ctx: PluginContext): Promise<CollectionSchemaInfo[]> {
  if (!ctx.schema) throw new InputError("Schema access is unavailable. Check Import's granted permissions.");
  return (await ctx.schema.listCollections()).filter(schema => !schema.hidden && schema.fields.some(writable));
}
export async function collection(ctx: PluginContext, slug: string): Promise<CollectionSchemaInfo> {
  const schema = await ctx.schema?.getCollection(slug);
  if (!schema || schema.hidden || !schema.fields.some(writable)) throw new InputError("Select an available collection with supported scalar fields.");
  return schema;
}
export function validateMapping(source: Source, schema: CollectionSchemaInfo, mapping: Mapping): void {
  if (Object.keys(mapping).length !== source.columns.length || Object.keys(mapping).some(key => !source.columns.includes(key)))
    throw new InputError("The mapping no longer matches the source fields. Map the data again.");
  const destinations = Object.values(mapping).filter(Boolean);
  if (!destinations.length) throw new InputError("Map at least one source field.");
  if (new Set(destinations).size !== destinations.length) throw new InputError("Each destination field can be mapped only once.");
  if (destinations.some(slug => !schema.fields.some(field => field.slug === slug && writable(field))))
    throw new InputError("A mapped field is missing or unsupported. Map the data again.");
}
export function convert(value: Scalar | undefined, field: FieldSchemaInfo): Scalar | undefined {
  if (!writable(field)) throw new InputError("Unsupported destination field.");
  if (value === undefined || value === null || value === "") return undefined;
  let result: Scalar;
  switch (field.type) {
    case "string": case "text": case "select":
      if (typeof value !== "string") throw new InputError("Expected text; automatic number-to-text conversion is disabled.");
      result = value;
      if (field.type === "select" && !field.validation?.options?.includes(value)) throw new InputError("Choose an exact configured select option.");
      break;
    case "number": case "integer": {
      if (typeof value === "boolean" || (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())))
        throw new InputError("Expected an unambiguous number without currency symbols or grouping separators.");
      result = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(result) || (field.type === "integer" && !Number.isSafeInteger(result)))
        throw new InputError(field.type === "integer" ? "Expected a safe whole number." : "Expected a finite number.");
      break;
    }
    case "boolean":
      if (value === true || value === "true") result = true;
      else if (value === false || value === "false") result = false;
      else throw new InputError("Expected true or false (lowercase).");
      break;
    case "datetime": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        throw new InputError("Expected an ISO datetime with seconds and timezone, such as 2026-10-07T12:00:00Z.");
      const date = new Date(value);
      const day = value.slice(0, 10);
      const calendar = new Date(day + "T00:00:00Z");
      if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day || Number(value.slice(11, 13)) > 23)
        throw new InputError("Expected a real calendar date and time.");
      result = date.toISOString(); break;
    }
    default: throw new InputError("Unsupported destination field.");
  }
  const rules = field.validation;
  if (typeof result === "string") {
    if (rules?.minLength !== undefined && result.length < rules.minLength) throw new InputError("Text is shorter than the field minimum.");
    if (rules?.maxLength !== undefined && result.length > rules.maxLength) throw new InputError("Text exceeds the field maximum.");
    // The host validates regex constraints. Do not run arbitrary patterns in the sandbox.
  }
  if (typeof result === "number") {
    if (rules?.min !== undefined && result < rules.min) throw new InputError("Number is below the field minimum.");
    if (rules?.max !== undefined && result > rules.max) throw new InputError("Number exceeds the field maximum.");
  }
  return result;
}
export function prepare(source: Source, schema: CollectionSchemaInfo, mapping: Mapping): PreparedRow[] {
  validateMapping(source, schema, mapping);
  return source.rows.map((row, i) => {
    const data: Record<string, Scalar> = {};
    const errors: string[] = [];
    for (const field of schema.fields) {
      const sourceKey = source.columns.find(key => mapping[key] === field.slug);
      const raw = sourceKey ? row[sourceKey] : undefined;
      const value = raw === undefined || raw === null || raw === "" ? field.default : raw;
      if (!writable(field)) {
        if (field.required || field.validation?.required) errors.push(`${field.label}: required field has an unsupported type.`);
        continue;
      }
      try {
        const converted = convert(value as Scalar | undefined, field);
        if (converted !== undefined) data[field.slug] = converted;
        else if (field.required || field.validation?.required) errors.push(`${field.label}: required value is missing.`);
      } catch (error) {
        errors.push(`${field.label}: ${error instanceof InputError ? error.message : "Invalid field value."}`);
      }
    }
    return { row: i + 1, data, errors };
  });
}
