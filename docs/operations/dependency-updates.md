# Dependency update operations

The default CODEOWNER owns dependency-update triage. Dependabot proposes every
npm minor and patch update as one weekly pull request, and the container base
images as a second. Each Dependabot pull request runs the complete CI and
rebases whenever the lockfile changes on main, so separate small proposals
crowd out the shared runners. Major versions are upgraded by hand. Major reviews and override reasons are
tracked in [the review log](dependency-reviews.md).

## Service levels

- Triage a security update on the same business day. Merge a green fix within
  72 hours or record a time-bounded risk decision in the release evidence.
- Review a green weekly batch within seven calendar days.
- For a failing batch, identify the failing package within two business days.
  Fix it in the batch, or defer that package below so the rest can merge.

## Deferrals

An intentionally deferred version must be recorded in this file before its PR
is closed or ignored. Record the package, current and proposed versions,
compatibility or operational reason, owner, decision date, and a review date no
more than 30 days later. The matching `ignore` entry in
`.github/dependabot.yml` keeps the version out of the weekly batch. Remove both
when upgraded.

| Package          | Current | Proposed | Reason                                                                                                                       | Owner    | Decided    | Review by  |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- |
| `@xmldom/xmldom` | 0.8.15  | 0.9.12   | 0.9 changes the parser's types and error handling; the SAML response parser needs a deliberate migration with its own tests. | @vigani1 | 2026-10-20 | 2026-11-19 |

## OpenTelemetry 3 migration (2026-11-12)

Owner: @vigani1. Completed the coordinated migration: API 1.10.0, stable SDK
3.0.0 and experimental SDK/exporters/HTTP instrumentation 0.300.0. Contrib
instrumentation moves with them: host metrics 0.7.0, Nest 0.71.0, PG 0.77.0,
Pino 0.70.0, runtime Node 0.37.0 and Undici 0.34.0. This replaces the November
10 hold and removes its version-specific Dependabot ignores.

Use the public `@opentelemetry/sdk-trace` and `@opentelemetry/core` exports;
`sdk-node` no longer re-exports `node` or `core`. Startup still loads before
application dependencies. The privacy and propagation tests retain their
assertions. `pnpm observability:qualify-sdk`, also run by `observability:check`,
exports parent/child traces and a counter through the actual startup SDK to the
pinned test collector, proving both signals and active context survive.

The API override now aligns every optional peer on 1.10.0. Keep this alignment:
otherwise core and database can load different Drizzle copies and
`instanceof DrizzleQueryError` misses the driver cause. The admission SQLSTATE
and rollback tests must continue to pass with their existing assertions.

## Coverage and release age

Dependabot covers npm, root Dockerfile bases, Compose services at the root,
single-server and observability directories, and pinned Actions in workflows and
local composite actions. Each ecosystem has a seven-day cooldown for routine
version updates. Security fixes follow the same-day triage and 72-hour merge
policy above: an urgent manual bump may bypass release age with its advisory,
upstream provenance, validation and reason recorded in the release evidence.

Dependabot does not update arbitrary checksum-pinned URLs in Dockerfile ADD
instructions. The weekly batch reviewer must also review Python tarballs and
Debian security package downloads in Dockerfile, and the script-only `rustfs/rc`
image used by deployment, against python.org releases, the upstream image registry and
Debian's signed security metadata; retain immutable URLs and verified checksums.
Record the reviewed pins and date in the batch PR, including “unchanged” when
current. This is an explicit manual part of the existing weekly update process.
Automating arbitrary download updates requires a separately agreed updater;
do not silently claim Dependabot covers them.

The [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
documents the supported ecosystems, directories and version-update cooldown.
Local composite Actions are scanned explicitly alongside workflows; their
SHA pins remain immutable until a reviewed update.
