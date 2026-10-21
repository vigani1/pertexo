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
