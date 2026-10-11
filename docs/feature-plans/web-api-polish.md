# Web and API polish follow-ups

Keep the Weft design language and existing contracts, envelope formats, state
owners and authorization boundaries. Deliver each numbered item in its own PR,
with lint, TypeScript, unit and mocked browser verification before pushing,
then rebase-merge only after CI passes. No new subsystem, role or CI job.

## Slices

- [x] 1. Enable local webhook envelopes; explain unavailable webhooks plainly.
- [x] 2. Make local invitations usable or explicitly unavailable; never 500.
- [x] 3. Record the add-connection setup test in connection health.
- [x] 4. Count missing or disconnected credentials in editor issues.
- [x] 5. Detect an unchanged live draft and explain reused publications.
- [x] 6. Fit and scroll the run-input dialog at 768 pixels high.
- [x] 7. Simplify workflow search, filters, selection and row actions.
- [x] 8. Add a step to the right of the selected step and link it forward.
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

## Credential issues

Slice 4 derives readiness from the editor's complete authorized connection
snapshot and the enabled draft steps, including enabled loop bodies. Missing,
unavailable, revoked, rejected or mismatched credentials join the issues chip,
canvas counts and Fix lens. Active credentials with unknown or inconclusive
test health remain selectable. Disabled steps and disabled loop bodies do not
add credential findings. A refreshed connection record supersedes the inline
add lens's temporary creation snapshot.

These findings are feedback about running the workflow; the existing server
validation continues to govern publication. A missing credential does not
silently introduce a new publication rule. Restoring a credential refreshes
the issue count without requiring a draft edit or another server validation.

## Unchanged publications

Slice 5 adds a current-publication comparison to the existing checked-draft
response. It uses the injected publication compiler's executable checksum and
the workflow's current published pointer, including when a higher-numbered
version is retained. Presentation-only edits do not create execution changes;
runtime, catalog and execution changes use the same identity as publication.
There is no new stored format or database column.

The editor disables Publish with “No changes since vN” only for its exact saved
snapshot. Unsaved edits, unfinished inspector input and stale checks cannot
disable it using an earlier comparison. A check inside an already-open publish
lens also stops an unchanged draft. An uncertain original command remains
recoverable. Publication receipts retain the server's reuse result: an already
live version says “still live”; reactivating an older retained version says
“live again”. Reuse does not animate a new version weaving into the canvas.

## Run-input scrolling

Slice 6 keeps the confirmation title, description and actions visible while
its form body scrolls within the existing viewport bound. Input cases, input,
deadline and error notices share that scroll area. The existing confirmation
pattern also keeps other long forms usable; command, focus and exact-retry
ownership do not change. Verified at 1280, 768 and 390 pixels wide by 768 high.

## Workflow list controls

Slice 7 keeps URL-owned search text editable, including spaces. React optimistic state holds typed characters while router
navigation completes, without a second committed search store. The query delays a
new name read by 250 ms using the query's cancellation signal. Server filtering
and pagination remain authoritative. Filters groups lifecycle, folder, tag and
favorites; Clear filters returns to active workflows and preserves sorting.
Bulk actions appear only for an explicit selection. Favorite and single-workflow
organization actions share the existing row menu; pending mutations and failure
feedback survive closing that popup. Existing glyphs, run strips and Weft tokens
remain the page's visual focus.

## Selected-step placement

Slice 8 follows one selected step on its own graph level, using a configured
visible output (first free, otherwise first) and the new step’s compatible
input. Measured card width and the existing body layout place it to the right;
collision handling and loop growth remain in the existing commands. Step and
link form one undoable transaction. Drag placement remains at the pointer;
no selection, multiple selections, missing outputs and inputless steps retain
standalone placement. The existing selection framing reveals the new step and
respects reduced motion. No extra camera effect or draft store is introduced.
