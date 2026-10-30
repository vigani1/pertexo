# Sharing within a workspace

Workspaces remain separate tenants. Folder restrictions narrow access inside a
workspace; they never give a person more authority than their workspace role.
Existing folders and unfiled workflows keep workspace access by default.

## Restricted folders

Owners and admins can restrict a folder to up to 100 named members or existing
SCIM groups linked to the workspace. An empty list means administrators only.
Viewer grants allow reading and the published-run actions already permitted by
the workspace role. Editor grants also allow authoring and publishing within that
role. A workspace viewer cannot become a builder through a folder grant.

At each folder, the highest matching member or group grant applies. Every
restricted ancestor must also grant access, and the lowest grant across those
ancestors wins. An unrestricted child never widens its parent. Owners and admins
retain access to every folder.

Workflow drafts, versions, retained runs and values, tests, samples, comments and
presence follow the workflow's current folder. Lists, counts, searches, usage
references, inbox notices and emails omit inaccessible workflows. A parent run
can deliberately return a child's output without granting access to that child's
private history.

Moving out of a restriction, or replacing one restricted ancestor with another,
requires an administrator to review the audience change. A move that only adds
restrictions keeps ordinary editor authority. A changed folder tree or workflow
organization revision invalidates the review. Folder deletion still requires an
empty folder.

Directory groups use current active bindings and membership. Removed or suspended
workspace membership cannot be revived by a group. Removing a member clears named
grants. Suspension preserves grants for restoration. Unlinking a directory or
deleting a group clears the corresponding grants; linking again does not restore
them. These removals also invalidate open sharing forms.

## Files and execution

Fresh downloads of run or preview files require a readable retained owner. A new
draft or run input cannot authorize its own file reference. An existing reference
in another readable workflow deliberately shares those immutable bytes.
Standalone user uploads remain workspace assets. Existing signed download links
expire at their normal short lifetime.

Published jobs already accepted through their triggers continue to execute their
immutable bindings. Folder sharing controls authenticated workflow and history
access; it does not cancel those jobs. New Call bindings require read access to
the target. Error-workflow settings still require edit access to both workflows.

Exports and imports, duplication and promotion copy no folder grants. Target
workspaces apply their own current rules. Sharing changes and audience-changing
moves are audited with bounded metadata, never secrets or run data.

## Folder API

`GET /v1/workspaces/:workspaceId/workflow-folders/:folderId/sharing` returns the
current mode, grants and folder revision to owners and admins. Replace sharing
with `POST` to the same address, with CSRF protection and an idempotency key:

```json
{
  "mode": "restricted",
  "expectedFolderRevision": 1,
  "grants": [
    {
      "kind": "member",
      "userId": "00000000-0000-4000-8000-000000000001",
      "access": "editor"
    }
  ]
}
```

Principal discovery is paginated at
`GET /v1/workspaces/:workspaceId/resource-sharing-principals?kind=member` (or
`kind=group`). It lists current identities for administrators, without creating a
new local group system.

`POST /v1/workspaces/:workspaceId/workflow-folders/review-move` reviews one folder
or up to 50 explicit workflows. Each result contains a token for that resource's
current review. An audience-changing move carries
`audienceReview: { "token": "…", "acknowledge": true }`; the server checks both the
administrator's current authority and the current review in the move transaction.

## Connection Use

Connections also start workspace-shared. Owners and admins can restrict Use to up
to 100 active workspace members. The active creator and administrators keep Use;
a removed creator does not. A named grant never raises the workspace role ceiling
or permits reading plaintext secrets, rotating credentials, or changing sharing.
Restricted connection names and health are visible only to people who can use
that connection, plus administrators. Workspace-shared metadata keeps its existing
reader visibility.

A new connection binding, publication, real single-step preview, or whole-draft
test needs Use. A saved draft may retain an unchanged unavailable binding, but
cannot exercise it through a new test or publication. Publication approval checks
the requester again before publishing. Existing published runs deliberately keep
their accepted credentials after a sharing change; revoking the credential itself
still stops its use through the existing revocation rules.

Administrators read or replace sharing at
`/v1/workspaces/:workspaceId/connections/:connectionId/sharing` with GET or POST.
POST needs CSRF protection and an idempotency key:

```json
{
  "mode": "restricted",
  "expectedSharingRevision": 1,
  "userIds": ["00000000-0000-4000-8000-000000000001"]
}
```

Sharing has its own revision, independent of secret rotation and health checks.
A stale form must reload. Removing a member clears their named grants and advances
that revision. Grants and secrets never travel through workflow exports or
promotion; target connections follow the target workspace's rules.

## Sharing in the app

Folders sit above the list in **Workflows**. A lock marks a restricted folder;
open one to see its path, who can open it and the folders inside. Owners and
admins use a folder's **⋯** menu, or **Share** inside it, to open **Share**.
Choose **Everyone in this workspace** or **Only people you choose**, then add
people or directory groups with **Can view** or **Can edit**. People are listed
with their email and role; owners and admins always keep access, so they're
shown but can't be added. **Save** stays off until something changes. If
someone changes sharing while the dialog is open, your edits stay visible and
**Reload** loads the current version before another save. A temporary read
failure also keeps your edits. If a save can't be confirmed, **Try again** sends
the exact same change; check its outcome before starting a different one.
**Filters → Manage tags…** holds the workspace's tags.

In **Connections**, open the connection, then **Share** to choose who can use
it. A lock marks restricted connections in the list. Viewers can't use
connections, so the picker says so instead of offering them. Neither dialog
shows credentials.

A move that removes a restriction opens **Review audience change**. Read the
listed restrictions and explicitly acknowledge the change. Bulk moves carry
independent review tokens, so each item can report its own result.

A readable workflow with Viewer access opens a view-only editor. Run actions
still follow the workspace role. If a fresh workflow read reports lost access,
the editor closes and clears its cached graph and related history. An unavailable
Call target or connection never reveals its private name.

## Backup and recovery

Sharing modes, grants, original member/group identities, resource relationships
and sharing revisions are part of the database backup. Restore them together; a
workflow export is not a backup of its access rules. Forced workspace isolation
remains in effect after restore. Supply encryption and callback token keys
separately, as described in the
[single-server recovery instructions](../operations/recovery.md#restore-drill-or-replacement-server).

The existing recovery qualification seeds restricted folders and connections and
checks that their grants, identities, revisions and workspace fences survive the
restore. Sharing does not change artifact bytes, encrypted credentials or the
retention and purge rules.
