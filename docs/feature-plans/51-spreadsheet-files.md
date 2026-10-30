# F51 — Spreadsheet files (Excel)

Status: approved by the owner on 2026-10-26 (recommended options delegated).
Delivery: one of four features combined in `feat/spreadsheets-attachments-and-task-timeouts`.

## Outcome

**Read file** turns an Excel workbook (`.xlsx`) into rows, and **Create file**
writes rows into one, the same way both already handle CSV. Teams can take the
spreadsheet they actually use, process it and send one back (with F49), without
converting to CSV first.

Benchmarks: n8n's Extract from File and Convert to File (XLSX), and the Excel
modules in Zapier and Make. Pertexo does it inside its own file steps, as n8n does.

## Current owners

- `packages/nodes-core/src/data/read-file/`: config is a discriminated union on
  `format` (`json`, `csv`) with `outputMode` inline or pages, CSV `delimiter`,
  and "convert numbers and booleans". `csv/` and `json/` hold the parsers;
  `conversion.ts` handles typing; `pages.ts` handles paged output (F45).
- `packages/nodes-core/src/data/create-file/`: union on `format` (`json`, `text`,
  `csv` with delimiter and ordered `columns`); `encode.ts` handles encoding.
  CSV protects cells that look like formulas.
- Limits: the 10 MB file limit, the item caps (about 5,000 rows inline, paging
  for more) and the step-data envelope already used by CSV.
- Guides: `docs/guides/files.md`, which lists Excel as later work.

## Decisions

- **One more format, `xlsx`, in both steps.** No new step and no second parser
  path: the reader produces the same row objects the CSV reader does, and
  `conversion.ts` and `pages.ts` apply unchanged.
- **Read options:** sheet (by name; default the first visible sheet), header
  row (default 1), and the existing "convert numbers and booleans" switch.
  Dates become ISO strings, formulas use their cached values (never evaluated),
  merged cells give the top-left value, and empty trailing rows and columns are
  dropped. Rich text becomes plain text.
- **Write options:** sheet name (default `Sheet1`), the same ordered `columns`
  as CSV (discovered when empty), and a bold, frozen header row. Values are
  written as numbers, booleans or text, never as formulas. Strings that start
  with `=`, `+`, `-` or `@` are written as text, so they can't become formulas
  (the same protection CSV uses). Objects and lists inside cells become compact
  JSON, as in CSV.
- **Safety, decided before parsing:** check the archive's entry count and each
  entry's uncompressed size from the zip directory before inflating anything.
  Reject a workbook whose total uncompressed size exceeds 100 MB, or with more
  than 1,000 entries, as `execution.file_input` with diagnostic reason
  `spreadsheet_too_large`. Stream-inflate with the
  same caps enforced. Cap at 256 sheets and 1,000,000 cells read per run step.
  Reject macros-enabled (`.xlsm`) and legacy `.xls` files as
  `execution.file_input` with diagnostic reason `unsupported_spreadsheet` and a
  hint to save as `.xlsx`. External links
  and embedded objects are ignored, never fetched.
- **Library:** one well-maintained library with no open advisories, a permissive
  licence and streaming read, that runs in the worker (Node only, never in the
  browser bundle). Evaluate `exceljs` and the `read-excel-file` /
  `write-excel-file` pair, plus any equally maintained alternative. The SheetJS
  npm package is excluded: its registry versions are outdated and have
  advisories. Pick by safety and maintenance first, then size. Record the
  choice and why in the plan's notes. It goes through the repo's normal
  dependency checks (exact pin, supply-chain scan, release age). If none
  supports bounded reading, wrap the zip layer with the caps above.
- **Errors** are the existing file failures plus the two codes above, registered
  like the other `file.*` problems.

## Editor and design

- The **format picker** in both steps becomes a row of small format tiles (JSON,
  CSV, Excel, Text), each with its own glyph, replacing the plain select. The
  selected tile lifts with the app's existing focus style.
- For Excel reads, once a file is mapped (from an upload or a pinned sample), the
  inspector shows a **sheet strip**: the workbook's sheet names as tabs, with
  the first rows of the chosen sheet in a tiny monospace grid preview (header
  row highlighted). This comes from the existing preview/test path. Without
  a file, it shows a soft placeholder grid. Sheet and header row stay editable.
- For Excel writes, a compact **column order** list (drag or arrows, reusing the
  CSV column editor), with a live "header → first row" preview line.
- Use the Weft tokens, type and motion. No layout shift when the preview
  appears. Check every size from 360 to 1920 px, light and dark.

## Tests

- Unit: parsing fixtures (types, dates, formulas with cached values, merged cells,
  multiple sheets, empty sheets, header row offsets), writing (column order,
  formula-like text stays text, JSON cells), and round trip (write then read).
- Safety: a zip bomb, too many entries, too many cells, `.xlsm`/`.xls`
  rejection and a corrupt file. Each fails fast with the right code and never
  exhausts memory (assert bounded behavior in the test, as the F45 heap tests do).
- Integration: the worker reads and writes through the artifact runtime with
  inline and paged output.
- Web: format tiles, sheet strip with preview, and the column editor.
- Live journey: upload a small `.xlsx` in the editor, read sheet 2, filter rows,
  write a new `.xlsx` with **Create file**, and download it to check the cells.

## Out of scope

`.xls` and `.ods`, formulas being evaluated, styles beyond the bold header,
charts, images, writing several sheets in one step, and templates.
