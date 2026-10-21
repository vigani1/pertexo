# Save run values

Use **Save run values** to label an execution with business data such as an order
ID, customer ID or invoice number. Open a step's **Setup**, choose **Add run
value**, and enter a key and a text value. The normal **Insert data** picker can
read an earlier step, run input or workspace variable; expressions remain
available. A whole values object can also be mapped in **Inputs**.

For example, after receiving an order, save `orderId = A-1042` and
`customerId = C-9`. In **Runs → Run value**, enter the key and exact value,
then choose **Apply value filter**. This combines with workflow, status and time
filters. Matching is case-sensitive and preserves spaces; empty text is valid.
Open the run to see **Saved run values**, with copy actions.

Keys begin with a letter or digit and use letters, digits, underscores, dots
or hyphens, up to 50 characters. Values must be text, up to 255 characters.
Convert a number explicitly with the normal mapping expression if needed.
An execution keeps at most ten different keys across all steps, branches and
loop iterations. Saving a key again replaces its value; the last committed
write wins. An attempt to add an eleventh key fails without saving any part of
that write. Repeating a save is safe.

**Use business data, never secrets.** Everyone who can read the execution can
read these values. Connections remain the place for credentials. Existing
provider/HTTP credential redaction applies before outputs are mapped; credential
field names and recognizable credential text are redacted again before saving.
This is not a general detector for arbitrary secret text pasted under an
innocent business key.

Published runs, draft test runs and single-step previews can record values.
A pinned step is not called and does not save values. Replays execute their own
steps and build new values; recovery that reuses a prefix starts with the source
run's retained values and later saves can replace them. Test runs stay in editor
history, so the main Runs filter never includes them.

Values expire with execution details: ordinary runs use the existing 30-day
policy, draft tests use seven days, and previews follow their existing expiry.
Expired metadata stops appearing in reads and exact searches even before physical
cleanup. Run deletion and workspace purge remove it. Workflow duplicate,
export/import and promotion carry the step and its mappings, never recorded run
values.
