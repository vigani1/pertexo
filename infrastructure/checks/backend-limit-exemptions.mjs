/**
 * Literals that are not limits, as `<file>: <literal>` (or `<file>: *` for a
 * file that is a format's parser) with the reason. A wire-format offset or a
 * protocol code stays a literal where it is read.
 */
export const NOT_LIMITS = Object.freeze({
  'packages/artifact-store/src/s3/telemetry.ts: 404':
    'S3 answers not-found with HTTP 404',
  'packages/artifact-store/src/s3/telemetry.ts: 412':
    'S3 answers a failed precondition with HTTP 412',
  'packages/artifact-store/src/s3/s3-responses.ts: 404':
    'S3 answers not-found with HTTP 404',
  'packages/queue/src/jobs/queue-job.schemas.ts: *':
    'the W3C traceparent layout: field offsets and widths',
  'packages/rate-limit/src/limiters/distributed-rate-limiter.ts: 3':
    'the length of the Lua script’s refusal reply',
  'packages/rate-limit/src/limiters/distributed-rate-limiter.ts: 6':
    'the length of the Lua script’s admission reply',
  'packages/templates/src/catalog.ts: 2': 'template versions',
  'packages/nodes-core/src/data/tables/data-tables.definition.ts: 2':
    'executor ABI versions',
  'packages/nodes-core/src/data/date/date.schemas.ts: "24 hours"':
    'the length of a day in the Days unit’s label',
  'packages/nodes-core/src/data/date/date.schemas.ts: "168 hours"':
    'the length of a week in the Weeks unit’s label',
  'packages/templates/src/catalog.ts: "five minutes"':
    'reviewed copy; catalog.test.ts ties it to each manifest’s run duration',
  'packages/templates/src/catalog.ts: "one-second"':
    'reviewed copy; catalog.test.ts ties it to the HTTP step’s timeout',
  'packages/templates/src/catalog.ts: "1,024 bytes"':
    'reviewed copy; catalog.test.ts ties it to the HTTP step’s answer size',
  'packages/templates/src/https-endpoint.validation.ts: 2':
    'a label’s first and last characters; a domain’s two labels',
  'packages/secrets/src/encryption/envelopes/envelope-format.ts: 3':
    'base64 encodes 3 bytes as 4 characters',
  'packages/secrets/src/encryption/envelopes/envelope-format.ts: 4':
    'base64 encodes 3 bytes as 4 characters',
  'packages/secrets/src/mail/deliver-system-mail.ts: 2': 'retry delays double',
  'packages/secrets/src/outbound-http/execution/routing.ts: 4':
    'IPv4 address family',
  'packages/secrets/src/outbound-http/execution/routing.ts: 6':
    'IPv6 address family',
  'packages/secrets/src/outbound-http/transport/node.ts: 4':
    'IPv4 address family',
  'packages/secrets/src/outbound-http/transport/node.ts: 6':
    'IPv6 address family',
  'packages/secrets/src/outbound-http/transport/address-policy.ts: *':
    'IP address parsing: families, prefix lengths, octets and word widths',
  'packages/secrets/src/outbound-http/redaction/decoded-body-view.ts: *':
    'JSON and percent escape layouts: escape lengths, hex radix, the space byte',
  'packages/secrets/src/outbound-http/redaction/response-charset.ts: *':
    'byte-order marks',
  'packages/secrets/src/outbound-http/redaction/response-redactor.ts: 11':
    'the unfinished escape kept past a credential’s length at a chunk boundary',
  'packages/secrets/src/outbound-http/redaction/sensitive-representations.ts: *':
    'credential spellings: hex radix and width, base64 padding, a query prefix',
  'packages/node-sdk/src/artifacts/pages/bundle.ts: 2':
    'JSON text: an empty page is its two brackets',
  'packages/node-sdk/src/artifacts/pages/encode-record.ts: 2':
    'JSON text: a page’s two brackets',
  'packages/node-sdk/src/artifacts/pages/write.ts: 2':
    'JSON text: a page’s two brackets',
  'packages/node-sdk/src/code/framing.ts: 10': 'the newline byte ends a frame',
  'packages/workflow-engine/src/compilation/checkpoint-capacity.ts: 64':
    'a SHA-256 digest is 64 hex digits',
  'packages/workflow-engine/src/completion/failure-notification.ts: 2':
    'the rank of a failed outcome among failure severities',
  'packages/workflow-model/src/authoring/portability/portable-manifest.ts: 16':
    'a digest byte printed in hex',
  'packages/workflow-model/src/authoring/portability/portable-manifest.ts: 2':
    'two hex digits per digest byte',
  'packages/workflow-model/src/execution/notice-schedule.ts: 2':
    'the bisection halves its interval',
  'packages/workflow-model/src/graph/validation/admission.ts: 2':
    'JSON text layout: the two brackets of a container',
  'packages/workflow-model/src/triggers/forms/files.ts: 2':
    'a list of two or more names joins with “or”',
  'packages/workflow-model/src/triggers/schedule-cron.ts: 3':
    'the month field’s position in a cron expression',
  'packages/workflow-model/src/triggers/schedule-cron.ts: 4':
    'the weekday field’s position in a cron expression',
});
