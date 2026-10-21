# Resume a Wait through a callback

Choose **Called back** in a Wait step’s Setup, then set a timeout from 1 second
to 30 days. The timeout starts when the workflow reaches Wait. Add a failure
route if the workflow should handle an expired callback.

In an earlier HTTP, Slack or email step, open **Inputs → Insert data** and choose
that Wait’s **Callback URL**. The picker offers enabled callback Waits later in
the same workflow level or For each body. It saves a reference, never a live URL.
The worker prepares the callback before sending its URL, so a fast reply is kept
even if it arrives before Wait opens. Downstream steps still wait for the
workflow to reach Wait.

For example, an HTTP request can send a `callbackUrl` placeholder in its address
or headers, or map its raw body to an expression object:

```jsonata
{"encoding":"utf8","value":$lookup($execution.callbacks,"wait-step-id").url}
```

This sends the URL as plain
text. The receiving service POSTs JSON, plain text or form-encoded data to that
URL. A JSON response such as `{"status":"ready"}` becomes the Wait output’s
`body`; permitted request headers are under `headers`.

Callback references may be placed directly in literal objects or arrays. They
cannot be transformed, concatenated, dynamically selected, saved through data or
Code steps, or returned as workflow results. This keeps the live credential out
of retained inputs, outputs, files and diagnostics. Known credential echoes are
redacted on both outbound HTTP responses and inbound callbacks. The receiving
service must also keep the credential private.

## Authentication and outcomes

- **Secret URL** is the default. Possession of the URL authorizes the POST.
- **Header secret** adds a generated secret from the same picker. Send
  `Authorization: Bearer <secret>` or use the configured dedicated header.
- **Signed** uses the normal [Pertexo webhook signature](webhooks.md): decode the
  mapped base64url secret to bytes, then sign the timestamp, a dot and the exact
  request bytes. Send `x-pertexo-timestamp` and `x-pertexo-signature`.

The first accepted response returns `202 {"accepted":true}`. A duplicate returns
409 while the task remains open; expired, canceled, consumed or completed runs
return 410. Invalid credentials use the same non-disclosing failure as webhooks.
Only POST changes state; GET and HEAD are refused. Rate limits and normal webhook
body limits apply (256 KiB, plus retained value depth/member bounds).

Each run, Wait and For each iteration has its own identity. Retries reuse the
same callback; replay creates a new one. Waiting releases active capacity and
pauses the execution clock through the existing pending-task mechanism; the
absolute run deadline still applies. Prepared callbacks consume the pending-task
allowance too. Cancellation and skipped targets close unused callbacks.

**Test workflow** issues real callback URLs and pauses at an unpinned callback
Wait. It requires the normal acknowledgement for unpinned sending steps. A pin
replaces execution. Duration Waits still complete immediately in tests.
Single-step previews never issue callback credentials. Test history and retention
remain separate from real runs; callback tasks are absent from human approvals
and Inbox.

## Installation, rotation and recovery

API and worker share `CALLBACK_TOKEN_KEY` (32 random bytes, base64/base64url),
`CALLBACK_TOKEN_KEY_VERSION`, and optional `CALLBACK_TOKEN_PREVIOUS_KEYS`:

```sh
CALLBACK_TOKEN_KEY_VERSION=2
CALLBACK_TOKEN_PREVIOUS_KEYS='[{"version":"1","key":"<original key>"}]'
```

The existing single-server secret generator creates the current key and version.
Save them in a password manager; never rerun the generator over an installation.
Deployed API and worker require the pair and refuse the public development key,
including in previous entries. At startup they independently verify retained
callback hashes. Wrong bytes or a missing version refuse startup clearly.

Rotate by setting a new random current key and version, retaining the old pair
in the previous-key list (at most eight versions). Both processes must use the
same ring and public web origin. Keep every version needed by retained callback
records and backups. Restore original keys separately from the password manager;
keys and environment files are never included in the database/object backup.
Callback credentials and responses expire with run details, including the shorter
test retention, and workspace purge removes them.
