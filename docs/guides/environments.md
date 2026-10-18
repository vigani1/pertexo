# Environments and promotion

Use separate workspaces for development and production. Each keeps its own
members, connections, variable values, table rows, public forms and webhook
credentials. Promotion moves reviewed workflow definitions between linked
workspaces on the same Pertexo install.

## Choose the target

In the development workspace, open **Settings → Promotion**. Its owner chooses a
target workspace from the workspaces they can edit. Choosing a target grants no
access: the person promoting must still have edit access in both workspaces.
The source owner can clear an unavailable target without regaining access to it.

## Review a promotion

Select up to 20 published workflows on the Promotion page, or use **Promote…**
from a workflow's published versions or a selection in the workflow list. Choose
an exact retained version of each workflow. Publishing a newer source version
does not silently replace the selected one.

Choose **Create drafts** (the default), **Publish**, or **Request approval** when
the target requires publishing approval. Publishing can activate schedules.
Requesting approval creates the same exact-draft review used by ordinary
publishing; the requester cannot approve it themselves.

**Review promotion** shows the proposed definitions and target differences:

- Connections match one active target connection with the same name, provider
  and authentication type. Matching follows the existing connection-name rule.
  Promotion never reads or copies credential bytes.
- Variables must exist in the target. The target's values are used; source
  values are never copied. Dynamic variable access is flagged for review.
- Tables must already exist by name, with compatible columns and unique keys.
  Target column IDs are rebound by current column name and type. Existing output
  aliases stay unchanged, including aliases from before a column rename.
- Calls require a published target counterpart of the **exact** source child
  version and checksum. Promote the child first, publish or approve it, then
  promote its parent. A newer child is not a substitute. Promote historical child
  versions separately when different parents pin different versions.
- Static workspace file references block promotion. Replace them with runtime
  mappings. Files and table schemas are not copied.

Missing or incompatible setup blocks applying. An unrelated workflow with the
same name is never adopted automatically; rename it or the source first.

## Protect target changes

A promoted workflow remembers its source. Later promotions update that target
copy. If someone edited its draft, name or publication directly, the review marks
it as a conflict. Read the differences and explicitly select **Replace these
target changes** before applying.

Apply rechecks the reviewed source versions, target draft revisions, settings,
bindings and access together in one transaction. If anything changed, review
again. A batch either applies completely or writes nothing. An uncertain network
result keeps the original command: use **Retry same promotion** before changing
anything.

Each result links to its target draft, version or publication review. History is
visible in both workspaces and follows their audit retention. Published target
versions keep immutable source correspondence while retained. Deleting a source
workspace or pruning its old versions does not delete the independent target
copies.

## What stays separate

Promotion never copies secrets, variable values, table rows, run data, pinned
samples or saved input cases. Existing target operational settings remain there:
alerts, concurrency, error workflows, webhook credentials and public form access.
Normal publishing reconciles new triggers; new forms start as members-only.

A review has a combined 2 MB graph budget, including current target graphs and
inspected child dependencies, and a 4 MB response bound. If the selection is too
large, select fewer workflows and promote children first. History pages are
bounded and do not retain graph snapshots.

For rollback, restore and publish a retained version in the target using the
usual approval rules. The next promotion shows that direct change for review.
Git-based promotion and promotion between separate installs remain later work.
