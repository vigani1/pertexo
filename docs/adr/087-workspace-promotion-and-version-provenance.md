# ADR 087 — Workspace promotion and version provenance

Status: accepted. Date: 2026-10-18. Feature: [F17](../feature-plans/17-environments-and-promotion.md).

Environments are ordinary linked workspaces on one install, as the owner requested.
A promotion target is configuration, not an access grant: every operation proves
current authoring access on both sides. Keep ordinary forced workspace row
security and existing roles, with explicit scoped transitions inside one bounded
transaction. A separate environment tenancy layer would duplicate isolation,
credentials and permission semantics without adding the requested behavior.

Promotion reviews immutable source versions and rebinds only typed references.
Connections match by name/provider/type; variable values and secrets remain in
the target; table aliases keep their meaning while column IDs rebind by name/type.
Source file references are refused rather than copied or left cross-scoped.
Target workflows remember their source and applied graph; direct target edits
require explicit reviewed replacement. A recomputed fingerprint and normal
idempotency receipt fence the atomic apply, without storing a second review graph.

Call pins require a published target counterpart of the exact source child version.
Version correspondence is recorded by the existing publisher only for an unchanged
promoted candidate, including F18 approval and checksum reuse. Promote/publish
children first; never create unapproved immutable versions to stage their parents
or silently repin to the latest child. This costs an explicit dependency order and
preserves the established publication and recovery guarantees.

Draft creation, direct publication and approval requests use existing authoring
and F18 owners. Approval has no promotion bypass. Audit facts supply promotion
history; target-owned provenance lasts with target workflows/versions, while
opaque source identifiers do not prevent source purge. No new service, role,
execution pipeline, portable format, secret copier or event ledger is introduced.
Git and cross-install promotion remain later.
