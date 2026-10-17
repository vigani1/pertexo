# Prepare data in a workflow

Find **Filter items**, **Sort items**, **Remove duplicates**, **Summarize items**,
**Batch items**, **Take first items**, **Concatenate lists** and **Convert date**
under **Shape data** in the editor. These steps operate on
JSON values. They need no connection and do not contact another service.

Use **Setup** to choose the operation, and **Inputs** to map the data it receives.
A path such as `$.amount` selects a field inside each item; `$` selects the whole
item. Map an `items` input from the run input or a linked predecessor's `$.items`
output. Links determine execution order; input mappings determine the data.

## Example: paid invoices, one per ID, totals by currency

Create this chain:

| Step | Setup | Inputs |
| --- | --- | --- |
| Manual start | None | None |
| Filter items | Item path `$.paid`; Comparison **Equals** | `items` from run input `$.invoices`; `value` from run input `$.paid` |
| Sort items | Sort by `$.amount`; **Numbers**, **Ascending**; missing/null fields **Last** | `items` from Filter items `$.items` |
| Remove duplicates | Compare by `$.id`; **Fail on missing keys** | `items` from Sort items `$.items` |
| Summarize items | Numeric value `$.amount`; Group by `$.currency`; **Fail on missing values** | `items` from Remove duplicates `$.items` |
| Stop run | None | `result` from Summarize items `$.groups` |

Publish and run with:

```json
{
  "paid": true,
  "invoices": [
    { "id": "a", "amount": 30, "currency": "EUR", "paid": true },
    { "id": "b", "amount": 10, "currency": "EUR", "paid": true },
    { "id": "a", "amount": 30, "currency": "EUR", "paid": true },
    { "id": "c", "amount": 20, "currency": "USD", "paid": true },
    { "id": "d", "amount": 100, "currency": "EUR", "paid": false }
  ]
}
```

Filter keeps four records. Sorting keeps ties in their original order. Removing
duplicates keeps three records and reports one duplicate. Summarize produces:

```json
{
  "groups": [
    { "key": "EUR", "count": 2, "sum": 40, "min": 10, "max": 30, "average": 20 },
    { "key": "USD", "count": 1, "sum": 20, "min": 20, "max": 20, "average": 20 }
  ],
  "inputCount": 3,
  "skippedCount": 0
}
```

Inspect these values in each step's **Output** in run history. Stop run's output
contains the groups under `result`. Ordinary workflows do not have the separate
callable-result declaration used by Call workflow.

## Choosing missing-value behavior

- **Filter:** a missing field never matches a comparison, including “Does not
  equal”. “Field exists” includes null; “Field is missing” selects an absent field.
  Equality never coerces numbers, text, true/false or null. Numeric comparisons
  require numbers; Contains text is case-sensitive.
- **Sort:** absent and null fields keep their original order in the first/last
  bucket, independently of ascending/descending order. Present keys must match
  Numbers or Text. Text uses a fixed, case-sensitive character order, without
  language-specific sorting.
- **Remove duplicates:** the first equal value wins. `$` compares whole JSON
  items; object field order does not matter, while array order and value type do.
  Null is a real key. Skipping missing keys reports `skippedCount` separately from
  `duplicateCount`.
- **Summarize:** values must be numbers. Missing/null numbers or absent group keys
  can fail or skip; wrong types always fail. Groups keep their first-seen order.
  Empty ungrouped input has one zero-count, zero-sum group with null min/max/average;
  empty grouped input has no groups. Arithmetic uses ordinary floating-point
  numbers, with no rounding; unsafe integer operands or intermediate sums fail.

## Dates and simple expressions

Convert date accepts integer **epoch milliseconds** for **ISO timestamp (UTC)**,
or a valid timestamp with an explicit offset for **Epoch milliseconds**:

| Input | Convert to | Output |
| --- | --- | --- |
| `1767225600000` | ISO timestamp (UTC) | `"2026-01-01T00:00:00.000Z"` |
| `"2026-01-01T01:00:00+01:00"` | Epoch milliseconds | `1767225600000` |

The input and output field is `value`. Seconds are not guessed. Timestamps require
`YYYY-MM-DDTHH:mm:ss`, optional 1–3 fraction digits, and `Z` or `±HH:mm`. Invalid
calendar days, leap seconds, 24:00, natural-language dates and missing offsets
fail. Instants stay within UTC years 0000–9999; there is no local-timezone inference.

Choose **Format timestamp** with an explicit IANA timezone such as
`Europe/Paris`. Named formats are **Date only** (`2026-01-01`), **Date and time**
(`2026-01-01 01:00:00`) and **ISO timestamp**
(`2026-01-01T01:00:00.000+01:00`) for the instant in the table above.
**Convert timezone** returns the ISO form in the selected zone. Pass the same
instant to `America/New_York` to get `2025-12-31T19:00:00.000-05:00`.
The explicit input offset establishes the original instant; selecting a zone
changes its representation, not the instant. Intl supplies daylight-saving rules.
Two occurrences of a repeated local hour retain their distinct ISO offsets.
There is no free-form pattern language or inference of ambiguous local times.

Choose **Add or subtract duration**, select minutes, hours, days, weeks or months,
and map a signed integer `amount` in **Inputs**. Positive adds; negative subtracts.
Minutes/hours/days/weeks are elapsed UTC durations: one day is 24 hours, even
across daylight-saving changes. Months use the UTC calendar and clamp to the
last day: `2024-01-31T12:00:00Z` plus one month becomes
`2024-02-29T12:00:00.000Z`; minus one month becomes
`2023-12-31T12:00:00.000Z`. Arithmetic returns UTC ISO. Only duration uses `amount`;
other operations ignore that optional mapping.

UTC is the editor's explicit default. Unknown zones and numeric-offset zone
selectors fail configuration; choose an IANA name. Local formatted dates must
also stay within years 0000–9999. Historical offsets containing seconds cannot
be expressed by the platform's minute-offset ISO contract: choose a display
format or a different zone instead. No host timezone or clock supplies defaults.

## Batches, prefixes and concatenation

| Step | Setup | Input | Output |
| --- | --- | --- | --- |
| Batch items | Batch size `2` | `items: [1, 2, 3, 4, 5]` | `batches: [[1, 2], [3, 4], [5]]`, `inputCount: 5`, `batchCount: 3` |
| Take first items | Count `3` | `items: [1, 2, 3, 4, 5]` | `items: [1, 2, 3]`, `inputCount: 5`, `removedCount: 2` |
| Concatenate lists | None | `items: [1, 2]`, `otherItems: [2, 3]` | `items: [1, 2, 2, 3]`, `inputCount: 4` |

Batch keeps order and the final partial batch. Use the [For each guide](for-each.md)
for iteration, expansion and concurrency limits.

### Batching work for For each

Map Batch items' `$.batches` to For each's `items`. With 4,998 IDs and a batch
size of 100, the body runs 50 times (the last batch has 98 IDs). Map **Current
item** to an HTTP step's bulk-list input, so one iteration sends one batch.
Start with **Items at a time** `1` and increase only within the service's limits.

For each accepts up to 4,998 items, but the run's 5,000 expanded invocations
include triggers, body steps and called children. Batching makes room for
longer bodies by processing a whole batch per iteration. A nested For each over
every batch member still counts every inner iteration; it does not reset the
5,000-iteration or expanded-invocation budgets. Batch itself also obeys the
4,998-item collection and existing value-size limits. Larger source datasets
need separate bounded runs, split before they enter these steps.

Take permits zero and returns the whole list if the requested count exceeds its
length. Concatenate preserves duplicates and nested lists; it does not join
records by key or flatten them. Its combined length must fit the collection cap.
Empty lists return empty `items`/`batches` and zero counts. A batch size must be
positive; batch size and take count must be integers within the collection cap.

For trim, uppercase, lowercase, joins and number conversion, choose **Expression**
on an input row and open **Expression examples**. Choosing an example replaces
that row's editable source. Review its `runInput` path and use **Test** with your
actual input; the displayed example result is sample data, not a completed test.
Expressions read run input and available predecessor outputs, not another mapped
field on the same step. A missing path does not invent a value; null or wrong
function arguments can fail. Number conversion explicitly uses `$number`.

All collection steps accept at most 4,998 items within the existing whole-JSON
limits: 1 MiB, depth 64 and 10,000 members. A wide collection can hit a whole-JSON
limit before 4,998 items. Input/output inspection, step testing, saved workflows,
export/import and For each bodies use the same current nodes and limits.
One-item batches at the cap use 9,999 members, including their count fields;
4,999 items would exceed the existing 10,000-member bound. Complex records and
summary groups may reach the member/byte limit sooner. No global limit is raised.
CSV/file conversion awaits F04's file-consumer contract; these steps accept JSON,
not file uploads.
