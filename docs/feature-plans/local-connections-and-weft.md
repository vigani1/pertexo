# Local connections and Weft page follow-up

## Scope

Enable Connections and Alerts in development with an explicitly configured local
key provider. API and worker share the provider and environment policy; deployed
configuration refuses it. Keep the existing sealed connection format and AWS KMS
path. Local keys are stable across restarts and remain server-only. Unconfigured
servers return an authenticated, workspace-authorized `connection.not_configured`
problem so the browser can explain what is missing.

Give Usage, Inbox, Runs, Team and Alerts one signature moment each using existing
threads, Status glyphs, loom and live-edge materials. Keep Settings, the role
matrix and forms plain. Usage keeps capacity accounting accurate and formats
storage bytes. Inbox lanes show actual retained failures over 30 days rather than
invented marks. Alert tests send a disclosed real message through the destination,
with existing connection-test idempotency and unknown-outcome handling.

## Verification

- [x] Local encryption round trip, context binding, tampering, independent runtimes.
- [x] API/worker config rejects local mode in staging and production.
- [x] Disabled routes preserve authentication and workspace disclosure rules.
- [x] UI behavior tests, React Doctor, lint, typecheck and tests.
- [x] Desktop and phone browser walkthrough and reduced motion; before/after images captured for the PR.

PR screenshots and CI results are recorded on the implementation PR.

## Implementation notes

- Inbox uses a finished-thread illustration with “No failing workflows” copy:
  the empty Inbox cannot claim that all active or queued work has finished.
- Removed members end at × in the removal receipt for the current session.
  The member API contains no permanent removal history, so the UI adds none.
- Usage distinguishes active runs (which can be waiting) from reserved slots,
  and shows at most 12 lanes with an explicit caption for larger limits.
- Alert tests pin the reviewed destination version, resolve the target on the
  server and reuse the connection-test dispatch ledger. An unconfirmed result
  is checked with the same idempotency key before another send.
- Browser verification uses the real empty development workspace and isolated,
  contract-validated populated fixtures. Fixture tests send no provider messages.
  Actual connections still require real service credentials.

Verification passed: repository `check`, all workspace unit suites (web/API/worker
rerun with four workers), 15 Inbox PostgreSQL integration tests and 11 browser
cases for Usage, Inbox, destination management and Team. React Doctor scanned all
29 changed frontend files: 92/100, no diagnostics, no suppression changes.
The browser pass checked desktop and phone views, including 320 CSS pixels,
with no page overflow. Reduced motion disabled all Usage and pending-test
animations. Screenshots include the actual workspace before/after and clearly
identified synthetic populated states.

The live Usage browser/API/PostgreSQL qualification also passed after its byte
assertions were updated to readable units and the exact byte title. The initial
CI browser failure was this stale raw-byte expectation; production behavior did
not change in the follow-up fix.
