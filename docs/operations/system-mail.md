# System mail

## System mail: Resend or SMTP

Pertexo sends verification, password reset, email-change confirmation and
workspace invitation mail through its worker. `SYSTEM_MAIL_TRANSPORT` defaults
to `resend`: configure `AUTH_MAIL_EMAIL_API_KEY` and `INVITATION_EMAIL_API_KEY`
with your verified provider key. Existing configurations remain valid.

For an existing SMTP submission server, set:

```dotenv
SYSTEM_MAIL_TRANSPORT=smtp
SYSTEM_MAIL_SMTP_HOST=smtp.example.com
SYSTEM_MAIL_SMTP_PORT=587
SYSTEM_MAIL_SMTP_TLS=starttls
SYSTEM_MAIL_SMTP_USER=your-provider-username
SYSTEM_MAIL_SMTP_PASSWORD=your-provider-password
```

Omit both Resend API keys in SMTP mode. Keep `AUTH_MAIL_FROM`,
`INVITATION_EMAIL_FROM`, `AUTH_MAIL_MODE=durable` and all generated encryption
keys. Use `implicit` for TLS from the start (default port 465). STARTTLS is
mandatory in `starttls` mode; certificate verification cannot be disabled.
Staging and production refuse plaintext. Username and password must be supplied
together; omit both only for a TLS relay you control that authorizes this server.
The generator does not create SMTP credentials; your provider issues them.

Keep the environment outside the checkout, mode 600, with a separate password
manager recovery copy. Preparation validates settings before stopping the
release and copies selected mail credentials only to the worker's private
configuration. SMTP settings do not go to API, migration or ops. Configuration
validation does not connect to the relay or prove its credentials. Deploy and
then request a verification or reset link for your own account; verify receipt
and invitation delivery before allowing real users. You configure the
provider's sending-domain verification, SPF, DKIM and DMARC records and any
host outbound-network rules. Portability does not mean running your own mail
server or guaranteeing deliverability.

A submitted status means the relay accepted the message, not that a mailbox
received it. Explicit temporary SMTP rejection can retry the same immutable
command; permanent rejection records failure. If the final acknowledgement is
lost, or a worker crashes while a dispatch is unresolved, SMTP cannot promise
deduplication. Pertexo leaves account mail `reconciliation_required` and
invitation attempts `unknown`; it never blindly resends them. A person can
request another account link. An unresolved invitation keeps the existing
resend restriction until you've established what the relay did. Do not clear
unknown records merely to enable resend; confirm acceptance or nonacceptance with
the relay operator first. Today that means asking the relay and leaving the row:
[operator commands](operator-commands.md) cover run attempts, not mail.

To change transport, stop workers and establish outcomes for all unresolved
commands before changing the private environment and deploying. This includes
Resend retry rows: a scheduled retry can follow a lost acknowledgement, not just
a definite rejection. Retryable rows can use the replacement transport only
after definite nonacceptance. Keep the sender
addresses authorized at the new provider. Do not switch an unresolved Resend
command to SMTP and assume its Message-ID prevents duplicate delivery. Restores
remain fenced and stopped; supply mail credentials separately from backups and
verify the selected relay before reopening serving.

### Personal notification email upgrades

Migration 0017 renames the existing delivery queue to `system_mail_deliveries`
without rewriting its messages or permissions. Stop old API/workers before
migrating and start the matching release afterwards. Keep encrypted payloads and
the application key ring; uncertain SMTP deliveries remain in reconciliation.

The supplied Caddyfile routes RFC 8058 one-click unsubscribe directly to the API
and redacts tokens/headers in runtime errors. Keep that route and filter when
customizing the proxy; nginx request/error logs must not see its query token.
Configure the external relay to DKIM-sign both unsubscribe headers. See the
[notification guide](../guides/notifications.md#mail-operator-requirements).
