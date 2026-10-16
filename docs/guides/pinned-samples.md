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
doesn’t import them either. Pins aren’t a full-workflow test mode or a test suite.

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
file** first to turn a JSON or CSV file into bounded JSON.

Samples expire 30 days after saving or confirming. Pin fresh data after expiry.
Replacing or removing a pin erases its old sample immediately. Existing test
results keep their own seven-day retention; removing a pin doesn’t rewrite a
finished test. Deleting a step removes its sample, and workspace deletion removes
all samples. A workspace can retain at most 1,000 pins and 16 MB of sample data
including bindings, with at most 200 per workflow. Remove unneeded samples if
storage is full.
