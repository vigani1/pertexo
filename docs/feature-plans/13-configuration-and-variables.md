# F13 — Workspace variables

Status: merged in #303; natural main/ARM qualification pending.
Updated: 2026-10-15. Parent: [product roadmap](../product-roadmap.md).

## Outcome and current code

Reuse non-secret workspace text, finite numbers and booleans in mappings as
`$vars.NAME`. Editing a value affects new independent runs; existing runs,
replays, recovery and their child workflows keep the original snapshot.

The shared `runs/commands/acceptance.ts` already admits every trigger, replay,
recovery and Call through one transaction. Attempt inputs are loaded under the
workspace and live attempt fence; callable results have a separate completion
projection. Restricted JSONata currently exposes runInput and nodeOutputs and
rejects named variables. Previews have their own durable admission. Extend these
existing owners; no service, package, role, queue or process environment binding.

Recommended decisions below are accepted under the owner's autonomous mandate.
Record snapshot retention and inheritance in ADR 078 because changing them after
runs exist would reinterpret executions.

## Values, permissions and edits

- Names match `[A-Z][A-Z0-9_]{0,63}`. Values are text (up to 4,096 characters),
  finite JSON numbers or booleans. No objects, null, arrays, interpolation,
  credentials or hidden/environment-specific values. False, zero and empty text
  remain values. Text uses the existing valid-Unicode/no-NUL storage rule.
- Maximum 100 variables and 32 KiB of canonical JSON per workspace. Validate the
  whole set once at the API boundary. Database constraints provide an outer JSON
  envelope fence; domain rules remain in TypeScript.
- All current workspace members may read values. Owners and admins manage them
  through an explicit variable-management capability in the existing role policy.
  Builders can insert/read variables without changing shared configuration.
- One `workspace_variables` row stores the current bounded typed value map and
  positive revision. Absence means revision zero and an empty set. A replacement
  command requires the expected revision and a stable idempotency key, returns a
  conflict on concurrent edits and preserves the person's local values. No second
  version-history table: immutable run snapshots provide execution history.
- Current membership/role is locked in the same tenant transaction as the write.
  Audit records changed names and revision only, never values. No secret heuristic
  can make these values safe for credentials: the UI says plainly that every
  member can read them and to use Connections for secrets.
- Renaming is remove/add in one set update. Show usages before removing a name;
  removal does not mutate published graphs or retained snapshots. New executions
  with a missing reference fail clearly instead of silently dropping the mapping.

## Snapshot and execution contract

- Add nullable bounded `variable_snapshot` JSON to runs and previews. Its single
  stored shape is `{ revision, values }`. Additive migration fills existing rows
  with revision zero/empty values; null is reserved for purged execution details.
- Fresh independent acceptance reads one committed variable row in the same
  transaction and inserts its snapshot with the run. Exact command retries reuse
  the accepted row and never refresh values. A concurrent edit linearizes at that
  snapshot read: the complete old or complete new set, never a mixture.
- A full replay and step recovery copy the source snapshot, regardless of a new
  version or changed input. A purged source snapshot refuses replay clearly; it
  never silently replaces history with today's values. Older runs start empty.
- Calls inherit the parent's snapshot at child admission, including nested Calls.
  This keeps a logical run consistent while waiting for capacity or a person.
  An error workflow is a new independent run and captures the current workspace
  set; its safe failure summary remains the only source-run data it receives.
- Attempt input loading carries the stored snapshot through the existing lease
  fence into mapping resolution; callable result resolution uses the same snapshot.
  Workers do not read the mutable workspace table during execution. Retries,
  waits, human responses, branches and loops therefore need no special cache.
- A preview captures current values at its own admission and uses them through
  the same resolver. Its exact retry uses that accepted snapshot.
- Expose only `$vars` as the new named JSONata binding. Keep every other named
  binding and forbidden construct blocked. Amend ADR 009 explicitly: this adds
  one immutable data binding, without adding operators, built-ins or a second
  expression policy/runtime. Bind a plain immutable copied value
  map, never the host environment or a callable object. Include it in the existing
  expression input byte/member/depth budget when the expression reads variables;
  unrelated expressions retain their original two-value context and exact bounds. A direct reference to a missing
  name fails that mapping clearly, even inside a conditional/exists guard; use
  whole-map `$lookup` for optional names. A dynamic lookup with no match fails
  when it is the mapping result; ordinary JSONata missing behavior elsewhere
  stays unchanged. Errors and history expose a safe missing-configuration code,
  never variable values.
- Current compiler/authoring checks allow JSONata mappings only on definitions
  that pin that policy (Set, conditions, list/date steps and Call). Preserve those
  immutable definition pins. Add one typed ValueSource `{ kind: 'workspace_variable',
  name }` for direct scalar lookup on any mapped input, displayed as `$vars.NAME`.
  The picker uses it, avoiding an expression worker for a simple value. Existing
  JSONata-capable mappings and callable expressions also bind `$vars` for computed
  values. Both paths use one captured map and missing-name lookup rule. This is
  an additive source variant inside the existing graph/executable envelopes;
  reader rollout precedes new references, with no new policy or envelope version.
- Run details expose retained non-secret snapshot/revision under existing run-read
  authorization so people can explain execution. Snapshot retention follows the existing 30-day completed-run detail window
  (logical expiry applies before physical cleanup), remains while a live task needs it and is removed with workspace purge.
  Preview snapshots follow preview retention. Reader/writer rollout must precede
  enabling variable mappings; roll back writers before old readers.

## Usage and UI

- `workflow-model/src/variables/` owns types and bounds; the server expression
  owner inspects JSONata's public AST for reference facts, never regex matching.
  Walk input mappings in root/body graphs and the callable result. Literal text
  containing `$vars.NAME` is not a reference. Typed variable sources and direct static expression reads name the value;
  computed reads or whole-map access conservatively mean "may use any variable".
- `database/src/tenant-access/variables/` owns scoped current-set commands and
  usage reads, exported through the existing tenant-access entry point. Reuse
  current pool leases, tenant transactions, current-authority and command receipts.
  Group schema under the existing schema area. No extra entry point.
- A bounded paginated usage endpoint scans at most one workflow (its bounded
  draft and current publication) per page and returns matching step/input names,
  including archived workflows clearly. Continue pagination through workflows
  with no matches; never report a partial scan as "unused". A response is bounded
  and supplies a continuation within a workflow when its references fill a page.
  It excludes retained historical versions and explains this. Current snapshots
  are historical execution facts, not editable references. Read workflow metadata
  only under the current workflow-read capability; no cross-tenant discovery.
- API owns the existing session/CSRF/rate-limit/error boundaries and typed public
  contracts. Settings commands remain cookie-only; automation tokens do not gain
  variable-management scopes implicitly.
- Web `features/workspace-variables/` owns queries, typed editor, usage and public
  interfaces. Workspace route composes a Variables page linked from Settings.
  Plain forms, explicit typed controls, no JSON editor for routine values. Keep
  Weft typography, Status glyphs and existing thread pieces; one quiet visual
  explanation of "new runs pick up changes; existing runs keep their values".
- The editor's Insert data picker lists variable name/type and inserts a typed
  variable source; explain snapshot semantics there. Queries own current values, local
  form state owns unsaved edits, one feedback owner per failed command. Stable
  command identity/body survive uncertain outcomes; conflicts retain edits.
- Desktop and phone layouts, keyboard labels/focus and reduced motion remain
  usable. Reuse primitives rather than inventing a design system.

## Verification and delivery

One F13 PR after F11 merges. Plan/ADR first. A mechanical move commit extracts
the existing valid-storage-text schema from Form fields into `json/text.ts` and
moves Forms’ exact retained-command hook into `lib/api/use-retained-command.ts`
for the second real consumer. Preserve behavior and update imports in that commit;
context-specific error wording changes belong to the later logic commit. ESLint explicitly allows only the model’s browser-safe `canonicalJson` export
in shared utilities; other model APIs and backend imports stay blocked. No
second copy of either rule. Other moves, if needed, stay in their own commits,
then coherent implementation and qualification commits. Every commit is gated
by lint, TypeScript and units; final gates include format/build, mocked browser,
contracts/OpenAPI, schema ownership, architecture/Knip and changed React Doctor.

Behavioral evidence must include finite typed limits; named-variable policy and
missing references; old/new snapshot coherence under an edit; duplicate acceptance;
replay/recovery preserving values; nested Calls; preview; task restart; current
role loss and forced workspace RLS; audit without values; retention; accurate
static/dynamic usage. A real API/worker/browser journey creates variables, maps
one, runs, edits it, replays and proves old/new outputs in SQL. Test desktop and
phone and attach synthetic screenshots. No external provider is needed.

## Tracker

- [x] Current owners and requested scope reconciled; recommendations recorded.
- [x] ADR and contracts complete.
- [x] Scoped persistence, snapshot admission and execution implemented.
- [x] Variable settings, usage and mapping UI implemented.
- [x] Independent persistence/runtime/browser evidence passed.
- [x] Rollout, guide, roadmap and remaining limits documented.
- [ ] PR green, rebase merged; inspect natural main result.

## Later work

Environment overrides, secret variables, automatic substitution into configuration
text, historical editable revisions and per-workflow variable ACLs are outside this
feature. Exports keep ordinary mapping references, never workspace values;
imports resolve names in their destination workspace. No placeholder service or
migration framework is added for later environments.

### Admission/mapping refinement from code inspection — 2026-10-15

The per-definition JSONata fence also exists in executable compilation and pin
verification, not only the editor. A direct typed variable source keeps that
contract intact and avoids changing every old definition or weakening the fence.
Scalar lookup and the expression binding share the same snapshot; no environment
lookup or second evaluator is added. Simple direct references do not spawn a worker.

The shared retained-command boundary also needs the existing 24-hour receipt
window and sticky uncertainty for HTTP 5xx after possible commit. Qualify those
behaviors for Forms and variables while adding this consumer; expired requests
never silently acquire new keys.

### Bounded usage and read-only workspaces — 2026-10-15

Each reference page analyses at most 100 candidate sources and 64 KiB of source,
inside at most one workflow. A continuation is returned even when this budget
finds no matching names, so large/invalid drafts cannot monopolize the API or
be reported as unused. Oversized expressions hit the existing 16 KiB profile
fence before parsing. Reference identities bind the draft revision/publication
and source position. No materialized index, cache or additional worker is needed.
Current members may read values/references in suspended or pending-deletion
workspaces too; writes and new independent admissions still require active state.
The existing current-authority read fence accepts that explicit status list.

After implementation, isolate the final mechanical placement of the shared
24-hour command constant, uncertainty classification and workspace API scope in a separate move commit.

## Qualification — 2026-10-15

- Real PostgreSQL: seven scoped configuration/usage tests plus eleven preview
  persistence tests. Initial CAS race, complete committed old/new sets, exact
  receipts, authority loss, read-only workspaces, forced RLS without caller
  filters, safe audit, replay/expiry/physical cleanup and no-match usage budgets.
- Real Redis/PostgreSQL workers: a three-run nested Call → Call → Request input
  journey, restarted while pending, finishes with 10 for original/replay and 20
  for a fresh run. Both typed mappings and a separately resolved JSONata callable
  result use the same snapshot. The existing recovery qualification now also
  edits configuration between source failure and recovery and proves the suffix
  retains the original set. No production hooks.
- Real API/worker/browser journey: an actual committed save loses its response
  behind a local browser gateway, then exact retry produces one revision/audit.
  A waiting run, replay and fresh run produce 10, 10 and 20; independent SQL
  checks outputs, snapshots and audit metadata. Desktop 1280px and phone 375px,
  reduced motion, labelled controls, keyboard submission and inspected synthetic
  screenshots in `docs/media/variables/`.
- Changed React Doctor: 100/100, no warnings or suppressions. Feedback rendering
  has its own small component; draft state remains in the editor. An explicit
  discard/reload queries current server values rather than reusing cached data;
  a failed refresh retains local edits.

Final local gates passed: 9,162 Vitest unit tests plus native checks; 176 mocked
browser tests including variable edit/conflict/uncertainty, read-only usage
pagination and the typed picker; TypeScript, lint, format/build, contracts,
88-table schema ownership, architecture and Knip. PR/main receipts follow
when observed. Local web
units are run with two workers to avoid saturating the laptop while checking
all 153 files; assertion deadlines and CI behavior are unchanged.

### CI contract correction

The first PR run passed 823 of 824 database integration tests. Its remaining
assertion compared the complete leased attempt input with the pre-F13 shape.
Reproduced locally (16/17 passing), then updated that exact assertion to require
`variables: {}` for a run with no configured values. Keep the strict equality;
this proves the additive empty snapshot rather than hiding it with a partial
match. No runtime change or history rewrite.

## Merge receipt

PR #303 rebase merged as `170adcae79109f3e0299c7e797a5ae2dc8a88f06`.
Corrected-head CI 38752254074 passed every required job, including 824 database
integration tests and the real browser batch; CodeQL 38752254073 passed. The
five source commits preserve history and the owner author, with no co-author.
Natural main CI 38755884223 and CodeQL 38755884421 are being inspected separately.
