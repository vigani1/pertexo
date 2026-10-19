# Step capability upgrades

Status: approved by the owner 2026-10-19; in progress.

The end-to-end logic pass ran every step type against the local stack on
good, empty, wrong, large and unusual input. The logic is sound, but several
things that n8n, Zapier and Make all offer were missing or narrower. The owner
approved building all of them before integrations and AI, deciding each one
the way those products do.

## Today

- **HTTP request.** URL, query and headers are fixed settings. Only the body
  takes run data. A JSON response comes back as one string that later steps
  can't read, and expressions may not parse it. Every call needs a headers
  connection, even to a public API. A GET that times out ends the run as
  "outcome unknown", without a retry or the failure link. Private addresses
  are always blocked, so a self-hosted install can't call its own services.
- **For each** keeps each pass's result inside the loop. Later steps see only
  the original list and a count (ADR 020).
- **Failure links** catch only connection, provider, auth, rate-limit and
  timeout failures (ADR 073). Bad input, a duplicate table key or a Code
  error ends the run.
- **Merge** outputs internal bookkeeping (attempt IDs), not what its branches
  produced.
- **Webhooks** accept only a JSON POST. Form posts get 415 and GET gets 404.
  The run sees the body but no headers or query.
- **Workflow search** matches capital letters exactly (ADR 064).
- **Date** refuses a plain date such as `2026-10-19`, which is what date
  columns and date pickers produce.
- **Forms** can't require a box to be ticked. A required yes/no field
  accepts "no", and new fields default to required, so that meaning can't
  change.
- **Field order.** Outputs, inputs and results are stored as PostgreSQL
  `jsonb`, which sorts keys. A CSV read as `name, qty` comes back as
  `qty, name`.

## Decisions

- **HTTP URL from data, origin fixed.** The URL setting stays and may hold
  `{name}` placeholders in its path. New optional inputs `pathParams`,
  `query` and `headers` fill them in, percent-encoded. The scheme, host and
  port stay as configured, so a connection's secret headers never follow run
  data to another host. Address checks still run at dispatch.
- **HTTP JSON.** When the inline response says JSON and parses within the
  node JSON limits, the body also carries `json`, which later steps map like
  any field. Text stays in `value` as today.
- **HTTP without auth.** The headers connection becomes optional. The node
  SDK's connection requirement gains an `optional` flag, publication checks
  only the required ones, and the editor stops saying "Needs a connection"
  for optional ones.
- **HTTP GET and HEAD are safe.** Their failures are classified as safe
  requests. A timeout or network error is a definite failure that retries
  under the step's policy and can follow a failure link. Other methods keep
  today's caution.
- **Private network, opt-in.** Operators may set
  `HTTP_ALLOWED_PRIVATE_NETWORKS` to a list of CIDRs (for example
  `10.0.0.0/8,192.168.1.20/32`). Matching addresses pass the dispatch check.
  The default stays empty, so nothing changes until someone sets it. Loopback
  passes only when listed explicitly. Cloud metadata addresses
  (`169.254.0.0/16`, `fd00:ec2::/32`) stay blocked whatever the list says.
- **For each results.** When a loop finishes, its output gains `results`:
  each iteration's sink output, in item order, within the node JSON limits.
  If the results would exceed them, the loop fails with a clear message to
  reduce inside the body. ADR 020 is amended.
- **Failure links catch step errors.** They also catch a step's own definite
  failures: invalid input or setup, data-table refusals, Code errors and
  provider failures. Cancellation, unknown outcomes, run deadlines and
  platform limits stay unhandled. ADR 073 is amended.
- **Merge passes data.** The output becomes `{ branches: { "branch-01":
  output, … } }` for the branches that arrived, plus `selectedBranchIds`.
  Bookkeeping stays internal.
- **Webhook requests.** POST accepts JSON, form-encoded and plain text, and
  GET is accepted too. A trigger setting "Run input" offers "Body" (today's
  shape, the default for existing triggers) or "Body, headers and query".
  The second gives `{ method, body, query, headers }` with credential,
  signature, cookie and proxy headers removed. Signatures still cover the
  exact body bytes. ADR 026 notes the GET and media-type rules.
- **Search ignores capital letters.** ASCII letters fold, as tag keys
  already do. Everything else matches literally. ADR 064 is amended.
- **Date accepts plain dates.** `YYYY-MM-DD` means midnight UTC. Format and
  convert apply their time zone afterwards. Free formats and local times
  without an offset stay refused.
- **"Must be ticked".** A yes/no form field gets an optional `mustBeTicked`.
  When set, only a tick is accepted, with "Tick this box to continue."
  Existing fields are unchanged.
- **Field order is kept.** Columns holding step inputs, outputs and results
  move from `jsonb` to `json`, which stores the text as written. Queries that
  need jsonb operators cast in place. Rows written earlier keep the order
  they already have. A new ADR records the stored format.

## Steps

- [x] 1. Small upgrades: plain dates, "must be ticked", search that ignores
  capital letters (with the ADR 064 amendment).
- [ ] 2. HTTP request: JSON responses, optional connection, safe GET/HEAD,
  URL placeholders with query and headers, private-network allowlist.
- [ ] 3. Failure links catch step errors (ADR 073 amendment).
- [ ] 4. Merge passes its branches' data.
- [ ] 5. For each returns its results (ADR 020 amendment).
- [ ] 6. Webhook request details, form posts and GET.
- [ ] 7. Order-keeping storage for inputs, outputs and results (new ADR).

Each step ships as its own PR with tests that fail without it, and is checked
end to end on the local stack with the QA step lab.
