# Audit log

Workspace owners and admins can open **Settings → Audit log** to see who changed
what and when. Builders, operators and viewers cannot read or export it. Events
record identities, actions, target IDs and bounded metadata. They never expose
connection credentials, tokens, variable values, table rows or run data.

Use **Person name** for a case-insensitive name match, **Action** for an exact
identifier (for example `workflow.published`), and **Target type** / **Target ID**
for a particular resource. Dates are UTC: **From** includes the chosen time;
**Before** excludes it. Filters stay in the address. Open **Event details** to
copy the event/person ID and inspect safe metadata. System actions have no person;
operator commands expose their operator reference in the safe metadata.

The log records actions from the time their audit coverage was introduced. It
does not reconstruct earlier missing events. A person's current display name may
change after an event. Old free-text metadata is hidden, even for administrators.
The underlying audit ledger remains append-only for application commands.

## Export

**Export matching events** streams all matching events, up to 100,000, in newest
first order. Larger selections are refused before CSV starts; choose a narrower
date range. Text is quoted and spreadsheet formulas are escaped. The browser's
download manager tracks the transfer; an interrupted transfer is aborted rather
than appearing as a complete CSV.

Audit and table exports share one download slot per workspace and two per API
instance. An extra export returns “An export is already running.” Each batch
rechecks access and releases its database connection before waiting for the
browser. A role change can interrupt an export. The download has a bounded time
budget of at most five minutes and is aborted after 60 seconds without write
progress. There is no snapshot guarantee across batches: changes during a long
export may be absent.

## Retention

Owners and admins of an active workspace can set **Keep audit events (days)**
from 30 to 2,555 days. The default is 365. Reducing the value permanently removes
older events when the existing retention worker next processes them. Increasing
it does not restore events already deleted. Saving retention is itself audited;
a conflicting save preserves your edit and asks you to reload settings.

Run inputs/outputs retain their existing separate policy. Workspace deletion
continues to minimize preserved audit facts under the existing deletion policy.
