import { parse } from "csv-parse/browser/esm/sync";
import { checkSourceSize, InputError, MAX_FIELDS, MAX_ROWS, safeKey, type Scalar, type Source, type SourceType } from "./model.js";
function checkColumns(columns: string[]): void {
  if (!columns.length || columns.length > MAX_FIELDS) throw new InputError("Use between 1 and 30 source fields.");
  if (columns.some(key => !safeKey(key))) throw new InputError("Field names must be 1–80 characters and cannot use reserved object keys.");
  if (new Set(columns).size !== columns.length) throw new InputError("CSV headers must be unique.");
}
function checkRows(rows: unknown[]): void {
  if (!rows.length || rows.length > MAX_ROWS) throw new InputError("Use between 1 and 100 data rows per import.");
}
export function parseCsv(text: string): Source {
  checkSourceSize(text);
  let records: string[][];
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: false, max_record_size: 48 * 1024 }) as string[][];
  } catch { throw new InputError("Invalid CSV: check closing quotes, escaped quotes, and the number of cells in each row."); }
  const columns = records.shift()?.map(key => key.trim()) ?? [];
  checkColumns(columns); checkRows(records);
  return { columns, rows: records.map(cells => Object.fromEntries(columns.map((key, i) => [key, cells[i]]))) };
}
export function parseJson(text: string): Source {
  checkSourceSize(text);
  let input: unknown;
  try { input = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new InputError("Invalid JSON: paste an array of objects with quoted property names."); }
  if (!Array.isArray(input)) throw new InputError("JSON must be an array of objects.");
  checkRows(input);
  const columns: string[] = [];
  for (const [i, row] of input.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new InputError(`JSON row ${i + 1} must be an object.`);
    for (const [key, value] of Object.entries(row)) {
      if (!safeKey(key)) throw new InputError(`JSON row ${i + 1} contains an invalid or reserved key.`);
      if (value !== null && !["string", "number", "boolean"].includes(typeof value))
        throw new InputError(`JSON row ${i + 1} contains a nested value. Only flat scalar fields are supported.`);
      if (typeof value === "number" && !Number.isFinite(value)) throw new InputError(`JSON row ${i + 1} contains a non-finite number.`);
      if (!columns.includes(key)) columns.push(key);
    }
  }
  checkColumns(columns);
  return { columns, rows: input as Record<string, Scalar>[] };
}
export function parseSource(type: SourceType, text: string): Source {
  return type === "csv" ? parseCsv(text) : parseJson(text);
}
