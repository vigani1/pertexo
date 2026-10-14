# Prepare data in a workflow

Find **Filter items**, **Sort items**, **Remove duplicates**, **Summarize items**
and **Convert date** under **Shape data** in the editor. These steps operate on
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

For trim, uppercase, lowercase, joins and number conversion, choose **Expression**
on an input row and open **Expression examples**. Choosing an example replaces
that row's editable source. Review its `runInput` path and use **Test** with your
actual input; the displayed example result is sample data, not a completed test.
Expressions read run input and available predecessor outputs, not another mapped
field on the same step. A missing path does not invent a value; null or wrong
function arguments can fail. Number conversion explicitly uses `$number`.

All collection steps accept at most 1,000 items within the existing whole-JSON
limits: 1 MiB, depth 64 and 10,000 members. A wide collection can hit a whole-JSON
limit before 1,000 items. Input/output inspection, step testing, saved workflows,
export/import and For each bodies use the same versioned nodes and limits.
CSV/file conversion awaits F04's file-consumer contract; these steps accept JSON,
not file uploads.
