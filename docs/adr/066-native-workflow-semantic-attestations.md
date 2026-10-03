# ADR066 — Native workflow semantic attestations

Status: **ACCEPTED — 2026-10-03.** Primary fully read the original proposal and
seal-expiry refinement, and accepted exact commit a6f555d0 after both independent
reviews closed the seal clarification. Bounded implementation and owned-local
qualification are authorized; registration, permanent serving activation, real
key provisioning and deployment remain separately gated. Release owner exclusively
allocated ADR066 after checking 15 trees and 189 references. That allocation and
direction selection alone did not authorize implementation or activation;
the separate acceptance above authorizes only the bounded scope below.
Parent [F08](../feature-plans/08-subworkflows.md), existing execution decision
[ADR065](065-durable-parent-child-workflow-calls.md), concrete proposed interfaces
and qualification [contract](../feature-plans/08-native-semantic-attestation-contract-proposal.md).

Native publication and nonliteral callable results require JavaScript compiler,
closure and restricted selector semantics that ordinary database-login SQL must
not be able to forge. Propose two purpose-separated, transaction-bound process
HMAC capabilities inside the existing publication and result-authentication
owners, preserving those semantic implementations and all independent SQL
authority/identity/CAS/receipt/provenance fences. Do not add a generic signer,
network service, second compiler/evaluator, scheduler or history owner.

## Explicit trust decision

The protection is against an ordinary serving database login without the signer
capability. Trusted signer processes, database/installation administrators,
definer owners and HMAC verification-key holders are outside that protection:
**an HMAC verification key can also sign**. A compromised trusted process can
attest incorrect semantics. SQL independently authenticates actual durable
tenant, authority, version/pin/closure, artifact/quota, delivery, transition and
commit facts, but does not claim to re-evaluate JavaScript. Existing successful
literal/runtime checks do not prove this new trust seam.

Signing follows actual durable verification, never a caller's verified flag.
The two closed owner interfaces bind installation identity, a server-minted
fresh outer-transaction challenge, backend/xid, tenant, purpose/protocol/key ID,
command or delivery, actual version/selector/revision, intended next CAS, exact
bounded bytes and source/content identities. SQL rechecks them under existing
locks and consumes one transaction-local proof only with the actual commit.
Abandoned passes discard proof; authentication/protocol failures roll back the
outer transaction operationally, never become definite child refusal.

## Key lifecycle and compatibility

Use separately generated publication/result keys; never reuse application
encryption, provider, webhook, cursor or absence-token secrets. Installation
identity, verifier material and activation are privileged owner-managed facts.
Serving roles cannot read or provision keys, mint a MAC through SQL, or access
an unrestricted proof table. Restore requires fresh installation identity and
challenges; historical tokens never authorize resumed execution.

Readiness must verify compatible process signer and database verifier before
traffic. Rotation changes the active key ID, allowing only bounded in-flight
outer transactions to finish under their pinned ID; unknown/revoked IDs fail
closed. Results for accepted native work need a currently permitted signer even
when new-publication/root writes are OFF. Disabling new writers is not permission
to strand accepted families. Retained nonnative workflows need no signer and
keep their existing formats and behavior.

Authorization expiry is checked at the required final SQL-clock seal, not at
physical COMMIT. SET CONSTRAINTS IMMEDIATE may fire that seal early; immutable
truth and a protected transaction denial marker must forbid alteration, reconsume
or reopening afterward. The unchanged closed facts may commit later. Key-fact
locks persist to outer transaction completion, so held transactions can delay
rotation/drain beyond expiry; controlled drain or held native traffic addresses
that operational condition, without a wall-clock retirement guarantee.

## Alternatives and consequences

A separate trusted database role alone would weaken the required ordinary-login
raw-writer fence when its credentials are available; it is not selected.
Duplicating JavaScript/JSONata/compiler semantics in SQL is not selected. Leaving
native nonliteral/positive writes OFF is the safe prequalification state, not
completion of accepted F08 behavior.

HMAC support, verification timing behavior, secret provisioning/rotation,
readiness and source-bound raw-role/replay/rollback/accepted-continuation proofs
are additional obligations. The exclusively owned PostgreSQL18.6 availability
probe found pgcrypto available but uninstalled and no registered bytea HMAC
function; it created no extension or key and removed its tmpfs database.
PostgreSQL documents bytea HMAC and explicitly limits pgcrypto's side-channel
claims; do not imply constant-time SQL comparison or unqualified cryptographic
protection. [PostgreSQL18 pgcrypto documentation](https://www.postgresql.org/docs/18/pgcrypto.html).

The accepted contract authorizes two existing-owner trust implementations and
owned-local qualification with disposable generated fixtures. Source extension,
grant and configuration definitions may be prepared for review. Only exclusively
owned disposable databases may install approved pgcrypto schema, ephemeral purpose
keys and temporary test-role grants; remove them after qualification and never
put secrets in argv, logs, evidence, repository or committed environment files.
Migration registration, permanent serving activation, human development database
changes, real key provisioning and deployment require separate exact-source
inventory, primary review and full F08 gates. Acceptance is not activation.
