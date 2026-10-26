# Pinned sample output

Open a step’s **Test** tab and choose **Paste JSON…**, or run a real test and
choose **Pin test output…**. In the step’s **Runs** tab, **Pin output…** copies a
successful retained run step’s result. A specific loop iteration has its own
result. Samples are shared with everyone who can read run data in the workspace;
only workflow editors can change them. Don’t use samples as secret storage.

A pinned test returns that saved JSON without calling the step, evaluating its
unused input mappings or contacting its service. The canvas and test result say
**Pinned**. You can use the output of that test as the input of a following step’s
test. **Check setup** still checks the real settings.

Published runs always execute their real steps. Publishing, running, replaying,
recovering, duplicating and exporting never carry pins along. Importing a workflow
doesn’t import them either. Use **Test workflow** to apply the pins across a saved draft. Use **Run all tests** to check all saved input cases as a suite.

## Test the whole draft

Choose **Test workflow** in the editor. Pertexo saves the draft first, then lets
you choose a saved input case, load the trigger’s pinned sample, or paste JSON.
Cases and pasted input are detached copies. A test never publishes the draft.

Pinned steps return their saved output. Every unpinned step executes for real:
review the list of steps that can change external data and acknowledge their
effects before starting. A test is not a provider sandbox.

The canvas shows live step progress. Open **Test history** to inspect each
result, **Pin output…**, or **Cancel test** while it runs. A changed draft hides
old progress from its canvas; the test history keeps its frozen draft labels.
One test can be active per person per workflow. Workspace capacity limits apply.

**Wait** finishes immediately and is labeled **Wait skipped in test**. Pin
**Approval**, **Request input** and **Call workflow** before testing beyond them;
an unpinned one stops with **Pin this step to continue the test**. Branching
pins must contain a valid `selectedPort` (for example `approved` for Approval).
**Respond to webhook** validates its response but never answers a real caller.

Tests appear only in the editor’s history, never the main runs list. They do not
send failure alerts, start error workflows, add inbox notices or change automatic
pause streaks. They keep their input, frozen pins, results and generated files for
seven days, and have a five-minute execution budget including queue time (or the
draft’s shorter limit). Published runs, replay and recovery always use real
published execution; a draft test cannot become their source.

## Run a saved test suite

Create or edit cases under **Input cases** after the workflow has a published
version. Each case has an expected outcome (**Succeeds** by default) and optional
value checks. Choose a step's output, enter a JSON path such as `$.amount`, choose
**Equals** or **Contains**, and enter an expected JSON value (`12`, `"USD"`, or
`{"currency":"USD"}`). A declared workflow result is available as **Final
output**; ordinary workflows should choose their result step instead. Pertexo
does not guess a last output across branches or loops.

Equals compares complete JSON values, including object keys and array order.
Contains checks a case-sensitive substring, one structurally equal array member,
or an object's properties with equal values. Missing paths, steps that did not
run, repeated step invocations and file-backed results are explicit failed
checks. For a loop, check a downstream summary step instead of an arbitrary
iteration. Use up to 20 checks per case, 4 KB per expected value and 16 KB total
expectations per case.

Choose **Run all tests** in the editor, review the ordered cases and acknowledge
all unpinned effectful steps once. Every case runs on the worker, one after
another, against the same saved draft, pins and workspace variables. Later edits
do not rewrite that suite. The suite uses workspace capacity just like a single
draft test. Its next case waits for queue space, with a five-hour total bound;
each admitted test still has at most five minutes including queue time.

Open **Test history → Suites** for pass/fail/error per case. **Report** shows
expected and actual values (large actual values have a labeled preview).
**View test** opens the existing step results, including **Pin output…**. An
ordinary failure continues to the next case. Unknown outcomes and timeouts are
errors, even when a case expects failure. **Cancel suite** cancels the current
test and skips the remaining cases; effects already performed cannot be undone.
Lost access or archiving stops later cases visibly.

The publish dialog shows the latest suite result and warns if it failed or if the
draft, cases, pins or variables changed. It never blocks publishing. Results are
shared with workflow editors who can read and start runs, retained seven days,
and listed only in the editor. Suite runs have the same test isolation from
alerts, inbox, error workflows and published execution as individual draft tests.

A workflow can have up to **50 active cases**, a workspace up to 200. Each input
fits within 64 KB; all retained inputs and expectations share the existing 4 MB
workspace case budget. Remove unneeded cases if that budget is full. Suites do
not add cases, pins or private reports to workflow exports.

## Review changed settings

Changing a step’s type, version, settings, mappings, credentials reference or
enabled state marks its sample **Pin needs review**. The sample isn’t used until
you **Confirm for this setup**, replace it or **Remove pin**. Moving or renaming a
step doesn’t change the sample. A stale or expired sample blocks tests; it never
silently calls the real service. Removing a pin restores the real test’s normal
setup and effects acknowledgement.

If Pertexo can’t confirm a save, use **Retry the same pin** before editing the
sample. This recovers the same request rather than overwriting another editor’s
changes. Conflicts preserve your pasted JSON so you can review before retrying.

## Limits and retention

Use JSON within the usual inline run-data limits: 256 KB, depth 64 and 10,000
members. File references and file-backed output can’t be pinned yet. Use **Read
file** first to turn a JSON, CSV or Excel file into bounded JSON.

Samples expire 30 days after saving or confirming. Pin fresh data after expiry.
Replacing or removing a pin erases its old sample immediately. Existing test
results keep their own seven-day retention; removing a pin doesn’t rewrite a
finished test. Deleting a step removes its sample, and workspace deletion removes
all samples. A workspace can retain at most 1,000 pins and 16 MB of sample data
including bindings, with at most 200 per workflow. Remove unneeded samples if
storage is full.
