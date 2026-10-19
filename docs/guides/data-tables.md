# Data tables

Keep small shared lookup lists and workflow state in your workspace, without
connecting an external database. Open **Data tables** in the workspace menu.
Every active member can read/export; owners, admins and builders manage data.
Use **Connections** for credentials. Tables are not secret storage.

## Create a table

Choose a stable name such as `Orders`. Names start with a letter and contain
letters, numbers and underscores, up to 64 characters. Add typed columns:

| Column | Type | Required | Example |
| --- | --- | --- | --- |
| order_id | Text | Yes | `00123` |
| amount | Number | Yes | `24.5` |
| paid | True / false | No | `false` |
| day | Date | No | `2026-10-17` |
| extra | JSON | No | `{"currency":"EUR"}` |

Optionally choose a required text, number or date column as the unique key.
**Upsert by key** needs one. Keys fit 1 KB including their JSON representation;
use a short business identifier. Duplicate keys are refused atomically.

## Change columns

Open **Edit columns**. You can add, rename or delete a column, or change the
unique key. Column types stay fixed. An optional addition fills existing rows
with empty cells unless you supply a default. A required addition needs a typed
default for every existing row. This backfill is not a default for future writes:
workflows must still provide required values.

Renaming keeps the column's identity. Existing configured workflow fields keep
their original aliases, including downstream output paths. For example, renaming
`amount` to `total` changes the table page and CSV header; a workflow configured
with `amount` still reads/writes that same column and returns `values.amount`.

Setup shows **amount (now called total)**. **Use the new name** opens a review
before changing this draft. For several renamed fields it adopts the new names
together, keeping each field attached to the same column, even when names have
swapped. It keeps the same set of bound columns; review removed columns first.

The review lists later output paths, whole-output consumers and paths inside
nested bodies. Expressions and Code can compute paths dynamically, so review the
listed programs manually too. Check this step's values, filters and sorting.
Mappings and input data are not rewritten for you: old paths can break or refer
to a different column after a swap. Cancel changes nothing. Confirm creates one
undoable draft edit; published versions keep their original names. A draft or
column-name change while the review is open requires reopening it. Row writes do
not invalidate the review. Test again before
publishing; normal pin and test-suite staleness rules apply.

Deleting asks for confirmation and removes that column's cells from every row.
Deleting the key column also clears the unique key. Workflows bound to a removed
column fail validation or are refused when starting an older published version.
Recreating the name creates a different column; it never silently revives a
binding. Older steps without explicit bindings require column review after any
column removal. In the step's Setup, choose **Review current columns**, review
Inputs, then publish. Existing aliases stay stable; new columns get new aliases.

A unique key must be a required text, number or date column. Existing values must
all be unique and fit the 1 KB key bound. Changing it changes which row **Upsert
by key** matches, so review those workflows. Clearing it disables Upsert until a
key is selected. All schema changes are atomic and audited: a duplicate, stale
revision, invalid default or quota failure changes nothing. Close and reopen the
dialog if another writer changed the table while it was open.

Deleting a table asks you to type its name. Workflows referencing it then fail
clearly; recreating the same table name is a deliberate retargeting choice.

## Read, edit and move rows

The table page shows 50 rows at a time. Filter by a column and sort ascending or
descending. **Edit** saves against the row revision you opened. If another writer
changes it, your edit stays in the dialog and saving is refused; close, refresh
rows and open the latest revision before applying your changes.

**Import CSV** accepts a UTF-8 file or pasted CSV, with an optional BOM and RFC
4180 quoting. Commas separate cells; quote commas, quotes and line breaks inside
cells. Headers must name every column exactly once. Imports are atomic: one bad
row, duplicate key or quota failure saves none of the rows. For example:

```csv
order_id,amount,paid,day,extra
00123,24.5,false,2026-10-17,"{""currency"":""EUR""}"
00124,10,true,2026-10-18,"{""currency"":""USD""}"
```

The column type controls conversion: text keeps leading zeroes, number needs a
finite number, boolean uses `true` or `false`, date uses a real `YYYY-MM-DD`, and
JSON needs valid JSON. JSON cells do not extend the retention of file references stored inside them. Empty optional cells become null. Errors identify the
record/column where possible. Import at most 1,000 rows and a 1 MB request;
JSON framing counts too. Split larger files into smaller imports.

**Export all rows** downloads the whole table. **Export filtered rows** downloads
every matching row. Neither is limited to the visible page or to 1 MB. Exports
use row creation order, independently of the page's current sort. Each batch
reads the current rows; this is not a snapshot. Rows changed during a
long export may or may not appear, depending on when their batch is read. Avoid
editing while exporting when you need a consistent copy. A column change or
loss of access interrupts the export; download it again after the change.

The server streams small batches directly to your browser's download manager,
which shows progress and lets you cancel. An interrupted export is a failed
download, never a successful partial CSV. An error before the transfer starts
opens a separate error page and keeps your table open. Retry the download after
addressing the error. Only one export per workspace and two per API instance
can run at once. Extra
requests say an export is already running; wait or cancel the active download.
The server releases its database connection between batches, including while
waiting for your browser. No write progress for about 60 seconds aborts the
transfer. The total budget is one minute plus one second per stored MB, capped
at five minutes (based on the whole table, even for a filtered export). Filter
very slow exports. Starts remain limited to five per person and ten per
workspace per minute.

Text that could execute as a spreadsheet formula is prefixed with an apostrophe.
This protects spreadsheet users; remove that prefix deliberately if importing
that text back into Pertexo.

## Use tables in workflows

Add a table step and choose a workspace table in Setup. In Inputs, use the normal
mapping controls for `values` or `query`. Table names are included in workflow
export/import; table schemas and rows are not. Create the named table in the
receiving workspace before running an imported workflow. Setup binds human field
aliases to stable column IDs. If an imported binding does not match the receiving
table (for example, a later-added column has a different ID), explicitly reselect
that table and review Inputs before publishing. No rows or schemas are imported.

| Step | Input | Result |
| --- | --- | --- |
| Find rows | `query` | `{rows, affected, hasMore}` |
| Insert row | `values` | One inserted row in `rows` |
| Update rows | `query`, partial `values` | Number changed in `affected` |
| Upsert by key | `values` with the unique key; a new row needs its required columns, an existing row changes only the given columns | One inserted/updated row in `rows` |
| Delete rows | `query` | Number removed in `affected` |

Each returned row contains `id`, `revision` and `values`. For example Find rows
returns `{"rows":[{"id":"…","revision":1,"values":{"amount":24.5}}],"affected":1,"hasMore":false}`.
Use `$.rows` as the list input for a following Filter or Summarize step, with the
value path `$.values.amount`.

A query can include up to ten AND filters, an optional sort and a row limit:

```json
{
  "filters": [{"column":"paid","operator":"equals","value":false}],
  "sort": {"column":"amount","direction":"desc"},
  "limit": 100,
  "offset": 0
}
```

Operators are `equals`, `not_equals`, `contains` (text), `greater_than` and
`less_than` (text, numbers or dates). `contains` ignores capital letters A–Z, so
"QUOTED" finds "quoted"; the others compare exactly. Values must match the
column type. Find
returns at most 1,000 rows and must fit the existing execution value bounds:
narrow the filter/limit when a result is too wide. Use `hasMore` and another
bounded query with a higher offset when paging.

Update/Delete change **all** matching rows, up to 1,000, and require at least one
filter. If more rows match, nothing changes: narrow the filter. Limit, offset and
sort are for Find; mutations do not select an arbitrary page. Insert and Upsert
validate every required column. Update keeps columns you omit.

Writes are effects during single-step tests, draft tests and suites. Acknowledge
them just like other effectful steps; pinned steps perform no write. Find is safe.
Retries after a crash reuse the same atomic write receipt and original result,
so an accepted insert is not duplicated. A deliberate replay/new run has a new
identity and may write again. Unique keys and Upsert help coordinate such runs.
Receipts expire with run data (7 days for tests, normal run-data retention for
published runs); preview receipts expire with their preview. Table rows remain
until you delete them or the workspace is purged.

## Limits

| Limit | Default | Owners/admins can raise to |
| --- | --- | --- |
| Tables per workspace | 20 | 100 |
| Columns per table | 20 | 50 |
| Rows per table | 10,000 | 100,000 |
| Stored cell JSON per workspace | 50 MB | 1 GB |
| One row | 64 KB | Fixed |
| Import / one row mutation | 1,000 rows | Fixed |
| Complete CSV export | Current table quotas | No separate file-size cap |

Open **Table limits** to raise bounded quotas. Lowering a quota below current
use is refused. Text/JSON must be valid Unicode without null characters. There
is no arbitrary SQL, custom index, type changes, row history or data beyond the workspace quotas in this slice.
