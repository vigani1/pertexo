# Connection credential boundaries

Connection credentials have two intentionally separate runtime boundaries.

- The schemas in `@pertexo/contracts/connections` own the untrusted HTTP wire
  representation accepted for connection creation and rotation. They reject
  unknown fields, normalize domain/header casing, and bound the bytes that may
  be encrypted and stored.
- The `resolved*CredentialSchema` exports in `@pertexo/integrations` own the
  post-decryption provider representation. Executors parse decrypted bytes
  again immediately before use because encrypted storage is not a substitute
  for validating the current runtime contract.

Both boundaries share schema version 1 and the same overlapping token,
mailbox, header-name, control-character, count, and serialized-header-byte
rules. The HTTP wire and resolved forms count `name:value\r\n` bytes, lowercase
and sort names, and prohibit transport-controlled headers. Slack accepts only
bot tokens with the `xoxb-` shape. Resend accepts only `re_` keys and normalizes
the mailbox domain while preserving the local part.

The duplicated schemas are intentional defense in depth: public contracts must
remain browser-safe and provider executors must not trust previously sealed
bytes. `apps/api/test/connections/credential-boundaries.test.ts` is the drift
gate for their shared semantics, including negative and byte-boundary cases.
Provider input/output schemas remain separately owned because they validate
message payloads rather than stored credentials.
