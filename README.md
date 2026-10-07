# Import

Import structured data into EmDash collections. A sandboxed HandyPlugins plugin,
prepared as **0.1.0** for `@handyplugins.co/import`. Requires EmDash **1.2.0+**.

## Use

Open **Plugins → Import → New import**. Choose CSV or JSON, paste the data, and
select an existing collection. Map each source field to a destination or ignore
it. Review the converted preview, then choose **Import valid rows as drafts**.
Results show created, updated (always zero), skipped, and failed counts. Imported
drafts appear in normal EmDash content management.

Preview validates every row and displays the first eight. It never writes content.
Invalid rows are skipped; a host write failure does not stop later rows. Preview
can catch conversion errors and missing required values; host regex/unique rules
and save hooks are checked during the actual write. No rollback is available.

## Sources

CSV requires a header row and equal column counts. The parser accepts UTF-8,
an optional BOM, LF/CRLF, quoted commas, escaped quotes, embedded newlines, and
empty cells. Blank lines are skipped. Headers are trimmed and must be unique.

```csv
name,price,active,date,notes
"Product, A",29.99,true,2026-10-07T12:00:00Z,"He said ""hello"""
Product B,39.99,false,2026-10-08T12:00:00+03:00,
```

JSON accepts one canonical structure: a nonempty array of flat objects with
string, finite number, boolean, or null values. Keys can vary between rows.
Nested objects/arrays, `{"items": [...]}`, and JSONPath are unsupported.

```json
[
  { "name": "Product A", "price": 29.99, "active": true },
  { "name": "Product B", "price": 39.99, "active": false }
]
```

Both formats reject dangerous keys (`__proto__`, `prototype`, `constructor`),
empty field names, and names over 80 characters. Literal control characters
other than tabs and line endings are rejected. Imported values remain data:
formulas and scripts are never evaluated, and text is never rendered as HTML
by the importer.

## Fields and conversion

| EmDash type | Accepted values |
| --- | --- |
| `string`, `text` | Strings; no implicit number/boolean-to-text conversion |
| `number` | Finite JSON numbers or decimal numeric strings, including exponent notation |
| `integer` | Safe whole numbers only |
| `boolean` | JSON booleans or the exact lowercase strings `true` and `false` |
| `datetime` | ISO datetime with seconds and `Z` or an explicit timezone; normalized to UTC |
| `select` | Exact configured string options; fields without options are unsupported |

Empty strings, missing values, and null are omitted. Supported scalar defaults
are converted and applied when available. Required fields, numeric bounds, and
text length bounds are checked before execution. Whitespace is preserved in
text. Numeric surrounding whitespace is trimmed; grouping separators, currency
symbols, hexadecimal values, and non-finite numbers are rejected. Date-only
values and timezone-free dates are rejected.

Portable Text, blocks, repeaters, media, relationships, URLs/slugs, custom-widget
fields, and other complex types are visibly unsupported. Entry identity,
publication status, locale, SEO, and other host metadata are reserved. Multiple
source fields cannot map to the same destination. A collection with a required
unsupported field cannot produce valid rows; the preview explains why.

Collections and fields come from `ctx.schema`, including custom collections.
Hidden collections are excluded. Large field sets use native field-slug inputs
instead of oversized dropdown matrices; the first 100 fields are listed for
reference. With over 100 available collections, enter the collection slug.

## Limits and execution

| Limit | v0.1.0 |
| --- | --- |
| Source text | 48 KiB (49,152 UTF-8 bytes) |
| Data rows per import | 100, excluding the CSV header |
| Source columns/keys | 30 |
| Preview display | First 8 rows; long values shortened |
| Preview lifetime | 30 minutes |
| Execution | Sequential writes; stop starting rows after 20 seconds |
| Private admin request body | 256 KiB (262,144 bytes), JSON POST |
| Retained history | Latest 50 non-running jobs; running/interrupted jobs preserved |
| Retained issues | Up to 20 per job, each at most 300 characters |

Current sandboxed Block Kit admin forms have no general user-facing file-upload
field, so this release uses multiline paste. The source limit leaves room for
the echoed confirmation form within the host's response budget. The host also
limits Block Kit responses to 256 KiB, individual strings to 64 KiB, depth to 20,
nodes to 2,000, and individual arrays to 1,000 items. These are response limits,
not a promise of a 64 KiB source textarea. See the official
[Block Kit contract](https://docs.emdashcms.com/plugins/creating-plugins/block-kit/).

Each confirmation is bound to its administrator, source, mapping, and schema
fingerprint. An atomic storage claim prevents duplicate/concurrent submission
of the same preview. Changing the data, mapping, or schema requires a new preview.

Content and job checkpoints cannot commit atomically. If a request is interrupted,
history can remain **running**, and counts reflect the last checkpoint. A write
may have succeeded after that checkpoint. Verify the collection before retrying;
automatic resume/retry is deliberately unavailable. The 20-second budget is
checked between rows and cannot cancel an in-flight host write. A host timeout
can still interrupt a slow operation. For budget-skipped rows, import only those
rows separately to avoid duplicating successful entries.

## Create mode, permissions, and privacy

This version creates new drafts only. It has no update, match, or publish mode.
The current plugin `ctx.content.update()` bridge does not accept an expected
content revision; safe concurrency-fenced updates are deferred. Each new import
creates new entries, even if identical data was imported previously.

The manifest requests `schema:read` for collection/field discovery and
`content:write` for draft creation. EmDash expands `content:write` to include
`content:read` in its normalized trust contract. There are no network, media,
email, or publish capabilities, and no allowed external hosts. The private admin
route uses normal host authorization and additionally requires an administrator
(role 50 or above). See official
[capability guidance](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/).

One plugin-scoped structured collection, `jobs`, stores ownership, format,
destination, status, timestamps, counts, schema version, a SHA-256 confirmation
fingerprint, and capped issues. It never stores source datasets, mappings,
converted record copies, or created-content IDs. Source data remains in the
current browser form and passes through the host while processing. Reloading
loses the source; a pending history record cannot resume an import. Clear history
removes only the job record, preserving content. Running jobs cannot be cleared
while their outcome is uncertain. At 100 retained/active jobs, new previews are
refused until old results are cleared. See official
[structured storage](https://docs.emdashcms.com/plugins/creating-plugins/storage/).

## Develop

Use Node **24.21.0** and pnpm **11.9.0**, with an independent package lockfile.

```sh
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm validate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bundle
corepack pnpm dev
```

Link this package into a sandbox-enabled EmDash site with `link:../import`, import
its generated descriptor as `importPlugin`, and add it to `sandboxed` alongside
the official workerd runner. Rebuild and restart the site when the descriptor
changes. Tests use the current official production runtime test host and cover
parsing, conversions, draft writes, partial failures, replay prevention, history,
authorization, and input/Block Kit limits. See official
[plugin testing](https://docs.emdashcms.com/plugins/creating-plugins/testing/).

CLI 0.13.3 needs a reproducible pnpm patch for Chokidar directory watching and to
bundle the browser-safe CSV parser and Zod Mini in both CLI and test-host builds. This patches
build tooling only. Recheck the workaround when upgrading the CLI.

Registry bundles enforce a 128 KiB per-file maximum. The runtime uses the official
[Zod Mini](https://zod.dev/packages/mini) API to keep validation within that limit.

The source modules separate `sources` (parsing), `mapping` (schemas/conversion),
`jobs` (confirmation/history/execution), `admin` (Block Kit), and `model` (shared
limits/types). No Automations dependency, proprietary event bus, or MCP tools are
added. Future upload/chunked sources can reuse the mapping and execution layers.

File upload, larger batches, safe update matching, templates, remote sources,
complex fields, transformations, schedules, and detailed logs are possible future
work, without commitments or feature gates.

## Release

Version is read from `package.json`. Trust-contract changes require a version
bump. The publisher DID matches HandyPlugins' existing Automations publisher;
the registry identity is `@handyplugins.co/import`, independent of the local npm
package name. Source repository: <https://github.com/HandyPlugins/emdash-import>.
This candidate has not been published. Package-profile authorization and the
actual release require a separate review.
