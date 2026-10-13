# SMTP system mail

Status: implemented and locally qualified; CI and merge are tracked by the
feature PR. Implementation was authorized after the completed self-managed
encryption feature. This plan covers portability of Pertexo's
account and invitation mail, not the workflow Email step or workspace Alerts.

## Outcome and scope

A self-hosted operator can use an existing SMTP submission server for account
verification, password reset, email-change confirmation and workspace
invitations. Resend remains the default, including existing deployments that
have no transport selector. The API still seals immutable mail commands; the
worker delivers them through the existing polling and queue runtimes. Local
printed authentication links remain development-only. No SMTP daemon, new
container, subsystem, database format, role, migration, ADR or CI job is needed.

Owner accounts, sending-domain DNS, deliverability and the real server launch
remain single-server beta slice 6. A local rehearsal cannot prove delivery to
an external mailbox. No real mail is sent during automated verification.

## Existing seam and known constraints

- `apps/api/src/authentication/mail/delivery.ts` enqueues sealed account mail.
  API identity configuration owns sender and encryption, not delivery secrets.
- `apps/worker/src/config/authentication-mail.ts` and
  `config/invitation-delivery.ts` currently require separate Resend API keys.
- `identity/authentication-mail-delivery.ts` polls leased account commands;
  `identity/invitation-delivery.ts` consumes existing invitation queue commands.
- Both handlers currently depend on the workflow Resend client. Move only their
  delivery dependency to a platform-mail interface in integrations; workflow
  Email and failure notifications keep their existing credential and client.
- Account claims already persist `outcome_unknown` before dispatch and support
  `retry` and `reconciliation_required`. Invitation attempts already distinguish
  `queued` from `unknown` and block manual resend while an outcome is unknown.
- Resend has provider idempotency. SMTP does not: even a fixed Message-ID does
  not guarantee server deduplication. An acknowledgement can be lost after DATA.
  Crashed or canceled dispatches must never be blindly resent through SMTP.

## Configuration contract

`SYSTEM_MAIL_TRANSPORT=resend|smtp` selects one system transport for both account
and invitation mail; absent means `resend` for backward compatibility. Delivery
keeps the current `AUTH_MAIL_*` / `INVITATION_*` keys, senders, timeout and polling
settings. In Resend mode the existing two `*_EMAIL_API_KEY` values are required
for each enabled delivery path. SMTP needs neither Resend key.

SMTP fields are worker-owned:

| Variable | Rule |
| --- | --- |
| `SYSTEM_MAIL_SMTP_HOST` | Required hostname or IP; no URL, whitespace or control characters |
| `SYSTEM_MAIL_SMTP_PORT` | Integer 1–65535; default 587 for STARTTLS, 465 for implicit TLS |
| `SYSTEM_MAIL_SMTP_TLS` | `starttls` (default), `implicit`, or development/test-only `none` |
| `SYSTEM_MAIL_SMTP_USER` | Optional username; paired with password |
| `SYSTEM_MAIL_SMTP_PASSWORD` | Optional password; paired with username; never logged |

`starttls` requires a successful TLS upgrade; no opportunistic fallback.
`implicit` starts TLS immediately. Certificates and hostname are checked using
Node's trust store, with TLS 1.2 minimum. Operators needing a private CA use
Node's existing `NODE_EXTRA_CA_CERTS` mechanism outside the beta Compose profile;
no insecure certificate-validation toggle is added. Plaintext is refused in
staging/production and only allowed against loopback in development/test.
Authentication may be absent for an operator-controlled TLS relay. No service
presets, arbitrary connection URLs, OAuth, proxy or pooling options are exposed.
Configuration errors describe the missing/invalid field without echoing secrets.
Selecting SMTP activates validation even if a local delivery path is otherwise
absent; partial settings cannot silently fall back to Resend.

## Files and responsibilities

`packages/integrations/src/system-mail/` holds at most four files:

- `contracts.ts`: typed immutable message, result and transport config.
  Results are `submitted`, `retryable`, `failed`, or `unknown`; no raw provider
  errors or SMTP responses escape. The client advertises whether the provider
  deduplicates replayed commands, for crash recovery decisions in the worker.
- `config.ts`: one environment parser used by both worker delivery configs.
- `client.ts`: binds Resend credentials and translates its established results
  and exceptions; constructs the selected adapter through one factory.
- `smtp.ts`: one bounded session per command using Nodemailer's documented
  SMTPConnection and MailComposer. SMTPConnection is needed to connect and
  authenticate before the worker's durable dispatch callback. Do not implement
  SMTP or MIME by hand. Add pinned `nodemailer` runtime and its type definitions;
  add `smtp-server` and its types as test-only dependencies in integrations and
  the worker, where real encrypted-queue delivery is qualified.

Export the interface, parser and factory through the existing `/server` entry
point only. Keep the browser entry point and workflow credential schemas intact.
Compose the account client in `worker.module.ts` and the invitation client in
`transport/providers/maintenance.ts`; use existing construction/cleanup rules.
There are no long-lived SMTP connections to close on worker shutdown.

## Delivery and recovery semantics

1. Compile one text-only MIME message with explicit single-recipient envelope,
   bounded existing content, disabled file/URL access and a deterministic
   Message-ID derived from the command identity and sender domain. Message-ID
   is a correlation reference, never a deduplication promise.
2. Set DNS, connect, greeting and idle timeouts and an overall deadline from the
   existing per-path timeout (100–30000 ms). Abort closes the session. Remove
   timers/listeners and clear temporary message bytes in every exit path.
   Never log SMTP traffic, credentials, recipients or message content.
3. Connect and authenticate, then await `beforeDispatch`, then send. If the
   callback refuses dispatch, send no message. Known pre-dispatch transport
   failures and explicit SMTP 4xx negative replies are retryable. SMTP 5xx
   rejection is permanent. A disconnect, deadline or cancellation after dispatch
   without an authoritative negative reply is unknown. A final positive DATA
   reply means submitted to the relay, not delivered to the recipient.
4. Extend existing database claim results to expose whether a command is being
   recovered from unknown dispatch. Use existing stored statuses, not a new
   format. SMTP recovery of an unknown account claim settles existing
   `reconciliation_required` without sending; invitation recovery leaves its
   existing `unknown` attempt untouched and acknowledges queue delivery.
   Resend recovery continues repeating the same provider-idempotent command.
5. For an invitation's known safe SMTP retry, return its existing attempt from
   `unknown` to `queued` in the store's existing locked transaction, only if it
   is still current, pending, unexpired and retains its token; then request
   queue redelivery. Never create a new token/attempt for an automatic retry.
   Unknown invitation results keep their sealed attempt and existing UI reason.
   Account safe retries keep the existing bounded exponential retry schedule.
6. Switching transports with unresolved unknown commands is unsafe unless the
   operator establishes their prior outcome. Document stopping workers and
   resolving outstanding unknown and uncertain Resend retry rows before switching; do not build a provider
   migration or reconciliation UI in this feature.

The conservative crash fence can leave mail unsent if a worker dies between
claim/dispatch marking and actual network transmission. This is intentional:
SMTP cannot prove whether that command was accepted. Account users can request
another link; unresolved invitation attempts require operator reconciliation
using the existing workflow, rather than a hidden duplicate send.

## Implementation and verification sequence

### 1. Transport and delivery integration

Implement the shared interface, configuration and adapters; bind both worker
paths. Extend claim recovery evidence and invitation safe retry using existing
statuses/locks. Behavioral tests must cover Resend's existing request/idempotency
behavior, SMTP success, Unicode MIME, one-recipient envelope, 4xx/5xx, bad login,
missing STARTTLS, invalid certificates, deadlines, cancellation, refused
beforeDispatch, post-DATA lost acknowledgement and socket cleanup. Test handler
settlement and recovery without repeating a message. Exercise the database
claim and retry behavior against an owned disposable PostgreSQL fixture.

### 2. Deployment and operator documentation

Update `storage/prepare.mjs` to parse configuration before stopping a release and
write only selected delivery credentials into private mode-600 `worker.env`.
Remove unconditional Resend keys from Compose. API, ops and migration containers
must receive no SMTP secrets. Keep old Resend deployment defaults working.
Document both modes in `.env.example`, `.env.production.example`, README and
`docs/operations/single-server.md`; amend the beta plan's Resend-only prerequisite
to reflect the completed alternative. Secrets generator stays unchanged: SMTP
credentials are issued by the owner's mail provider, not generated by Pertexo.
Include configure/change/recover steps, TLS requirements, SPF/DKIM/DMARC owner
responsibility, submitted versus delivered, unknown outcomes and secret storage.

### 3. Qualification and completion

Run full lint, TypeScript, unit and static repository checks, operational helper
tests, targeted owned database/service integration and mocked browser tests.
Run real SMTP sessions against an in-process loopback test server with public
test certificates, including STARTTLS and implicit TLS; no Docker mail image or
new CI service is needed. Verify deployment-prepared role files for both modes
and packaged runtime module resolution through the existing runtime image
qualification path. Test a password containing quotes, backslashes, dollar signs
and surrounding spaces in the actual Compose-launched process; rendered config
is escaped for reuse and cannot substitute for that assertion. Keep real SMTP credentials and launch checks in owner slice 6.

Use coherent verified commits, keeping any moves separate. Open a small feature
PR with Moved/Removed/Lines accounting and an updated tracker, preserve the
owner's unrelated frontend changes, and follow the established green-CI
rebase-merge workflow. Do not broaden this feature into workflow SMTP nodes,
provider failover, delivery receipts, pooling, bounce handling or a mail server.

## Tracker

- [x] Shared transport, safe delivery/recovery and behavior tests.
- [x] Deployment settings and operator documentation for both modes.
- [x] Local and packaged qualification; CI and merge are the PR gates.

Local evidence: 8,583 unit tests across all workspaces, 56 targeted database
integration tests, two worker mail integration tests (including real SMTP),
three live organization browser tests using the updated canonical invitation
handler, 144 mocked browser tests and 42 operational helper tests passed.
Packaged helper qualification passed both transports with both encryption modes
using the cached runtime plus current compiled code and Nodemailer; the actual
production Dockerfile is built and qualified by existing CI. Production
npm audit found no known vulnerabilities. No real mail or Docker image download
was used. An initial parallel local run exceeded existing worker child-process
startup deadlines; its complete worker suite passed separately without changing
assertions or timeouts.

## References

- [Nodemailer SMTP transport](https://nodemailer.com/smtp): TLS and timeouts.
- [SMTPConnection](https://nodemailer.com/extras/smtp-connection): documented
  connection/login/send lifecycle and errors.
- [MailComposer](https://nodemailer.com/extras/mailcomposer): safe MIME composition.
- [SMTP Server](https://nodemailer.com/extras/smtp-server): in-process test fixture.
- [RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html), sections 4.2, 4.5.3.2.6
  and 6.1: response classes, final DATA acknowledgement and duplicate risk.
