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

Convert date accepts integer **epoch milliseconds**, a plain date such as
`2026-01-01` (what date columns and date pickers give, read as midnight UTC), or
a timestamp with an explicit offset:

| Input | Convert to | Output |
| --- | --- | --- |
| `1767225600000` | ISO timestamp (UTC) | `"2026-01-01T00:00:00.000Z"` |
| `"2026-01-01"` | ISO timestamp (UTC) | `"2026-01-01T00:00:00.000Z"` |
| `"2026-01-01T01:00:00+01:00"` | Epoch milliseconds | `1767225600000` |

The input and output field is `value`. Seconds are not guessed. Timestamps require
`YYYY-MM-DDTHH:mm:ss`, optional 1–3 fraction digits, and `Z` or `±HH:mm`. Invalid
calendar days, leap seconds, 24:00, natural-language dates and times without an
offset fail. Instants stay within UTC years 0000–9999; there is no local-timezone
inference.

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

An expression has limits that protect the server: 100 ms to run, a fixed amount of
memory, and 1 MB of result. One that needs more memory or returns more fails its
step. One that runs out of time is tried again, because a busy server can cause
that, and fails the step if it keeps happening. Work on less data, or split the
work across steps.

All collection steps accept at most 4,998 items within the existing whole-JSON
limits: the SDK envelope is 1 MiB; retained execution JSON is capped at 256 KiB, depth 64 and 10,000 members. A wide collection can hit a whole-JSON
limit before 4,998 items. Input/output inspection, step testing, saved workflows,
export/import and For each bodies use the same current nodes and limits.
One-item batches at the cap use 9,999 members, including their count fields;
4,999 items would exceed the existing 10,000-member bound. Complex records and
summary groups may reach the member/byte limit sooner. No global limit is raised.
CSV/file conversion awaits F04's file-consumer contract; these steps accept JSON,
not file uploads.

## Text, numbers, XML, HTML and signatures

These utilities are under **Shape data**. They do not fetch documents or call provider endpoints; HMAC only resolves its key through the existing secret store. Map data in
**Inputs**, choose behavior in **Setup**, and map `$.value` into the next step
(except Extract HTML, whose list is `$.items`). All use the existing step-data
limits: a whole invocation up to 1 MiB, with retained JSON output up to 256 KiB, depth 64 and 10,000 members. Results that
expand beyond these bounds fail with advice to split the input; limits are not
raised by these utilities.

### Format text

Choose uppercase, lowercase, trim, replace, split or truncate. Case uses explicit
en-US Unicode casing. Replace maps `value`, `search` and `replacement`; **All**
chooses every non-overlapping match, otherwise only the first. Search is literal,
not regex; `$&` in replacement is literal too. An empty replacement removes the
match; an empty search is refused.

Split maps `value` and a nonempty `delimiter`, returning a list under `value`.
`"a||b|"` split on `"|"` becomes `["a", "", "b", ""]`. Keep at most 4,998 items,
within the whole value envelope. Truncate counts Unicode code points, preserving
surrogate-pair characters; combining marks can still be separate code points.
The optional `…` occupies one place inside the selected limit.

### Format number

Map a finite numeric `value`. Pick a locale (en-US, en-GB, de-DE, fr-FR or ja-JP),
grouping and minimum/maximum fraction digits (0–20). Decimal, Percent and Currency
are display formats, without text parsing or currency conversion. For example,
1234.5 with de-DE, grouping and two digits becomes `1.234,50`; 0.25 with Percent
becomes `25%`. Currency requires a three-letter uppercase code such as EUR.
JavaScript floating-point and Intl rounding apply; this is not financial arithmetic.

### Convert XML

**XML to JSON** takes XML text in `value`. Strings stay strings, including `001`;
attributes use `@_`, text beside children/attributes uses `#text`, and repeated
siblings become arrays:

```xml
<orders><order id="001"><total>12.50</total></order><order id="002"><total>7</total></order></orders>
```

```json
{"orders":{"order":[{"@_id":"001","total":"12.50"},{"@_id":"002","total":"7"}]}}
```

**JSON to XML** takes that object in `value`, with exactly one root. Attributes
and `#text` are scalar values; arrays repeat the corresponding element. Text and
attributes are escaped. Empty elements become empty strings when parsed. Namespace
prefixes are preserved, as are whitespace values (XML normalizes line endings and
attribute whitespace). Comments, declarations and processing instructions are not
data; mixed content is normalized into children and joined `#text`, so this is not
a lossless document formatter. DTD/custom entities and reserved object names are
refused; built-in and numeric character references work. Up to 48 nested elements
and 8,000 elements/attributes, with the usual output envelope. Malformed errors
show line/column without echoing the document. Nothing loads a DTD or resolves a URL.

XML creation checks encoded size, including repeated names and escaped text, before allocating the output. Boolean attributes become quoted `"true"` or `"false"`; null attributes are omitted. Null elements become empty elements, while `#text` needs text, a number or a boolean. Give nested lists named child elements instead of using anonymous arrays inside arrays.

### Extract HTML

Map HTML text in `value`. Select **Extract text** or **Extract attribute**, enter
a CSS selector (for example `main > a.invoice`) and a result limit (default 100,
up to 4,998). Attribute extraction also needs a name such as `href`; a missing
attribute produces an empty string. Results keep document order. `matchCount`
reports total matches and `truncated` tells you whether the chosen limit omitted
matches. Feed `items` into Filter, Take or other list steps.

Supported selectors: tags, classes, IDs, attributes and descendant/child/sibling
combinators. At most 256 characters, four selector groups and 16 total tokens; each group may have one descendant and one flat structural pseudo-class. Use child (`>`) or adjacent (`+`) combinators for longer paths. Structural pseudo-classes such as `:first-child`, `:nth-child(2n+1)`,
`:last-of-type`, `:empty` and `:root` work. General sibling (`~`), relational/content pseudos, nested selectors
(such as `:has()` or `:not()`) and pseudo-elements are refused. Documents are bounded to
48 levels and 8,000 elements/text nodes/attributes during parsing. Scripts never
run, URLs are never fetched, and output is text/attribute strings, not safe HTML.
Keep it in ordinary text fields rather than rendering it as markup.

### Crypto and HMAC signature

**Crypto → Hash text** hashes exact UTF-8 `value` using SHA-256, SHA-512 or MD5,
with hex/base64 output. **MD5 is not for security.** For example SHA-256 of `hello`
in hex is `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`.
**UUID** generates UUID v4; **Random ID** generates 1–256 URL-safe characters
(default 24). Both use the cryptographic system RNG and generate a new value on
each execution, including an explicit re-execution.

For **HMAC signature**, add a **Signing key** connection, paste the exact UTF-8
key and select it in Setup. Spaces and newlines are part of the key; it is never
trimmed. Keys are 1–4,096 UTF-8 bytes and stored encrypted, with existing access,
rotation and revocation controls. **Check key access** only opens the key locally;
it does not prove that an external service will accept the signature.

Choose SHA-256 or SHA-512 and hex/base64, then map the message in `value`. Only
the signature is output. The key never goes into workflow configuration, mappings,
exports or step outputs. Workspace variables are non-secret values; this step uses
an encrypted connection instead of treating a variable as a secret store.

### Lists from larger files

[Read file → Output pages](files.md#work-with-larger-data-as-explicit-pages) and HTTP's Save items as pages keep larger sources as ordinary JSON-array files. For each over `pages`, Read file each Current item inline, then Filter/Summarize that page or use an inner loop. Batch items still accepts only bounded inline lists; it never loads a whole paged result. Whole-run and checkpoint bounds still apply. XML, HTML and other utility steps keep their existing inline bounds.
