# Send email

Add **Send email** and select a workspace Email connection. It can use either
Resend or [SMTP](connections.md). Map To, Subject and Text; the connection owns
the sender address and, for SMTP, its optional display name. Attachments use the
same verified stored files, scratch spool and limits for both transports; see
[Attach files to an email](files.md#attach-files-to-an-email).

A successful step means the service accepted the message, not that it reached a
recipient's inbox. SMTP returns the Pertexo attempt identifier as `emailId`, a
local receipt rather than a provider-assigned ID. Credentials and SMTP replies
are excluded from receipts and safe errors.

SMTP has no provider idempotency guarantee. An interrupted send whose acceptance
is unknown remains unknown and is never automatically sent again. Check the
relay before explicitly replaying or retrying that step. A definite refusal before
acceptance can use the existing retry policy. Resend retains its existing
provider-idempotent behavior.
