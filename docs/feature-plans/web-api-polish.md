# Web and API polish follow-ups

Keep the Weft design language and existing contracts, envelope formats, state
owners and authorization boundaries. Deliver each numbered item in its own PR,
with lint, TypeScript, unit and mocked browser verification before pushing,
then rebase-merge only after CI passes. No new subsystem, role or CI job.

## Slices

- [x] 1. Enable local webhook envelopes; explain unavailable webhooks plainly.
- [x] 2. Make local invitations usable or explicitly unavailable; never 500.
- [x] 3. Record the add-connection setup test in connection health.
- [ ] 4. Count missing or disconnected credentials in editor issues.
- [ ] 5. Detect an unchanged live draft and explain reused publications.
- [ ] 6. Fit and scroll the run-input dialog at 768 pixels high.
- [ ] 7. Simplify workflow search, filters, selection and row actions.
- [ ] 8. Add a step to the right of the selected step and link it forward.
- [ ] 9. Stabilize save-state width and tidy editor header links.
- [ ] 10. Put HTTP credentials first and display human-readable sizes.
- [ ] 11. Call graph edges links; reserve connection for credentials.

## Verification

Each checked slice means its implementation and local verification are complete;
the slice's PR records CI and merge. Preserve real development data. Test
authorization and late-response ownership where the change touches them, and
check rendered controls at desktop and phone widths. React Doctor's changed
scan checks introduced diagnostics; report its scope honestly.

## Invitation availability

Slice 2 uses the permitted disable-with-a-reason option locally. Token protection
is required before issuing or resending an invitation; unconfigured issuance is
reported in the authorized invitation list and as a typed 503 for commands.
Viewing and revoking existing invitations remain available. Local auth-mail mode
is not invitation delivery; enable the existing token and worker mail settings
together when sending real invitations.

## Setup-test history

Slice 3 captures the existing secret-version and health-revision fence when a
test resolves its credential, so completed DNS or destination-safety failures
before dispatch also record their test time and reason. Provider success or
credential rejection still requires dispatch evidence. Rotation, revocation
and newer test or run health protect the current record from stale outcomes.
The inline add lens returns the tested connection rather than its earlier
creation snapshot. Retained historical records are not rewritten.
