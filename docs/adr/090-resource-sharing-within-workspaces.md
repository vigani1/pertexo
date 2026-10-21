# ADR 090 — Resource sharing within a workspace

Status: accepted on merge of the owner-authorized F48 plan PR. Date: 2026-10-21.
Feature: [F48](../feature-plans/48-finer-sharing.md).

## Context

F07 organizes workflows into bounded nested folders; connections and workspace
roles already have separate owners. The owner requested restricted folders and
connection sharing without replacing the workspace tenant, running automations,
SSO/SCIM roles or F18 governance. These rules determine durable grant semantics
and cannot safely be scattered across endpoints, SQL policies and the browser.

## Decision

Keep the workspace as the tenant/isolation boundary and current workspace
capabilities as the ceiling. Active workspace owners/admins retain full access.
Resource Viewer/Editor are grants, not new workspace roles.

Folders default to workspace access. A restricted folder grants named current
members or existing linked SCIM groups Viewer or Editor. Use the highest matching
grant locally and intersect restricted ancestors. A child cannot widen its parent.
A workflow and its retained authoring/run material follow its current folder;
there is no per-workflow ACL or stored permission snapshot. Unfiled workflows and
unchanged installations retain their existing behavior.

Connections separately default to workspace access. Restricted Use belongs to the
active creator, named active members and administrators, within the role ceiling.
Use conveys no secret read or connection administration. Check every referenced
connection at new publication and draft/preview execution, as well as replacement;
checking only a changed connection ID would permit credential reuse through an
edited destination or mapping.

Existing immutable published workflows deliberately delegate their accepted
bindings when run. Sharing changes do not silently break those automations,
including accepted Call/public-trigger/callback paths. They never grant direct
read access to another restricted resource's private history. Ordinary connection
revocation, workspace status, effects policy and run controls remain authoritative.
No general data-taint system or retained-output rewriting is introduced.

One TypeScript resource-authorization owner extends `database/tenant-access` and
composes the existing role policy. API, query, inbox/delivery, execution admission
and promotion consumers use it. SQL stores indexed workspace-fenced facts and
filters by TypeScript-produced query scopes; it does not evaluate another ACL
language. The browser consumes projected allowed actions rather than computing
permissions. Directory groups reuse the existing identity authority.

Apply visibility before list/search/count pagination or aggregation. Commands
recheck current permissions under existing ordered transactional fences; access,
tree and directory changes serialize with them. Idempotency does not preserve
revoked authority. Streams and export batches recheck access without holding a
connection across client backpressure.

Only owners/admins change ACLs or approve moves that remove/replace effective
restrictions. Restricted non-empty folders cannot be deleted into unrestricted
root. Record access edits and audience-changing moves through F18, metadata only.
ACL rows belong to resources/workspaces and are never exported or promoted.

## Consequences

A restrictive ancestor can make an otherwise granted child inaccessible. A
workspace viewer does not gain run permission from a folder grant. Editors may
need a connection Use grant before testing or republishing an existing workflow,
while its approved live version continues operating. Administrators retain a
recovery path and existing publication-review separation still applies.

Already disclosed data cannot be recalled. Existing signed file URLs retain their
bounded TTL; instant revocation would require a separate download architecture.
Workspace-wide capacity/configuration and intentional workflow outputs are not
new confidentiality boundaries. No service, workspace/database role, local group
system, policy engine or CI job is introduced. Exact bounds, coverage and delivery
slices belong to the short feature plan.
