# Your first workflow

This guide starts with a new single-server install and ends with a manual run
that needs no provider account or connection credential. The
[glossary](../../CONTEXT.md#core-terms) explains drafts, versions, runs and
steps.

## Install and sign in

Follow the [single-server runbook](../operations/single-server.md) for Linux,
Docker, DNS/HTTPS, private configuration, mail, generated keys and deployment.
Use its first-account setup procedure; opening the page alone does not bootstrap
an administrator. Verify the account email, sign in at your configured app
origin and create or enter a workspace. Use an owner, admin or builder account
for authoring. Invited viewers cannot edit workflows.

## Build a small manual workflow

Open **Workflows**, choose **New workflow**, and create a blank workflow with a
name such as `First run`. In the editor, add a **Manual start** trigger and a
**Set fields** step from the step picker. Connect the trigger's output to Set
fields. Select Set fields, open **Inputs**, and choose **Add input**. Set
**Field** to `message`, keep the literal source, and enter `"Hello"` (including
JSON quotes) in **JSON value**. Apply any pending configuration and save the
draft. This builds the output object `{"message":"Hello"}` without a connection
credential.

Publish the saved draft. Resolve any validation findings before confirming.
Publishing creates an immutable version; saving alone does not publish.

## Run and inspect

Start a manual run of the published workflow, using `{}` as input. Open its run
and inspect the step timeline and Set output. The run should finish successfully
and show your message. If it fails, inspect the failed step's safe error before
trying again. A run with an unknown external outcome requires explicit recovery
review; this first workflow has no external effect.

Edit the message, save and publish again to try versioning. The earlier run
keeps its original version and output. Next try
[data transforms](data-transforms.md), [HTTP requests](http-requests.md) and
[connections](connections.md), or return to the [guide index](README.md).
Examples available during workflow creation/import may need explicit provider
bindings; they are separate from this provider-free run.
