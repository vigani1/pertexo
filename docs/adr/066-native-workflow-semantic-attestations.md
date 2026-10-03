# ADR066 — Native workflow semantic attestations

Status: **PROPOSED — 2026-10-03.** Primary selected this bounded direction and
release owner exclusively allocated ADR066 after checking 15 trees and 189
references. Allocation/direction selection is not acceptance of this document,
implementation authorization, provisioning, permanent grants or activation.
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

Primary must fully read and accept this ADR and its concrete contract before
trust implementation. No new key, extension, environment configuration, SQL
grant, serving registration or rollout mutation is authorized by this proposal.
