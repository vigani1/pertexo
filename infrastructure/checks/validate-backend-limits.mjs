import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

// LIMITS_CHECKED as it stood when the check began; it never drops one of these.
const ORIGINAL_LIMITS_CHECKED = Object.freeze([
  'packages/policy',
  'packages/rate-limit',
  'packages/queue',
  'packages/templates',
  'packages/node-catalog',
  'packages/artifact-store',
  'packages/observability',
  'packages/secrets',
]);

/** Backend workspaces reworked so far; each new one joins once its limits are named. */
export const LIMITS_CHECKED = Object.freeze([
  'packages/policy',
  'packages/rate-limit',
  'packages/queue',
  'packages/templates',
  'packages/node-catalog',
  'packages/artifact-store',
  'packages/observability',
  'packages/secrets',
  'packages/workflow-model',
  'packages/node-sdk',
  'packages/workflow-engine',
]);

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
  'packages/node-sdk/src/values/stored-json.ts: *':
    'JSON string encoding: quotes, escape widths, UTF-8 widths and surrogates',
  'packages/workflow-engine/src/checkpoint/admission.ts: *':
    'JSON text layout: literal widths, brackets and separators',
  'packages/workflow-engine/src/compilation/executable.validation.ts: *':
    'JSON text layout: literal widths, brackets and separators',
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
  'packages/workflow-model/src/flow/callbacks/references.ts: *':
    'JSONata AST shapes: path step counts, argument counts and the `$lookup`/`$execution` prefix lengths',
  'packages/workflow-model/src/graph/validation/admission.ts: 2':
    'JSON text layout: the two brackets of a container',
  'packages/workflow-model/src/triggers/forms/files.ts: 2':
    'a list of two or more names joins with “or”',
  'packages/workflow-model/src/triggers/forms/files.ts: 1024':
    'bytes below a kilobyte print as bytes',
  'packages/workflow-model/src/triggers/forms/files.ts: 10':
    'megabytes print with one decimal',
  'packages/workflow-model/src/triggers/schedule-cron.ts: 3':
    'the month field’s position in a cron expression',
  'packages/workflow-model/src/triggers/schedule-cron.ts: 4':
    'the weekday field’s position in a cron expression',
  'packages/workflow-model/src/values/text.ts: *':
    'UTF-8 and UTF-16 encoding: byte widths, code point boundaries and surrogates',
});

// Unit factors: 1_000 ms in a second, 60 seconds in a minute, 1_024 bytes in a KB.
const UNIT_FACTORS = new Set([60, 24, 1_000, 1_024]);
const BIT_OPERATORS = new Set([
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
]);
const DURATION_STRING = /^\d+(?:ms|s|m|h|d)$/u;
const UNITS = String.raw`(?:milliseconds?|ms|seconds?|minutes?|hours?|days?|bytes?|characters?|KB|MB|GB)`;
// A limit written into text: "30000 milliseconds", "32-byte", "five minutes".
// An encoding's name ("UTF-8 bytes", "UTF-16 units") is not a limit.
const LIMIT_IN_TEXT = new RegExp(
  String.raw`(?<!UTF-)\b(?:\d[\d,_]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|sixty|ninety)[\s-]${UNITS}\b`,
  'giu',
);
const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/** Literal limits in one file: numbers and duration strings outside a named constant. */
export function findWrittenLimits(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (isNamedConstant(node) || ts.isTypeNode(node)) return;
    if (ts.isNumericLiteral(node) && isLimit(node))
      found.push(literalText(node));
    else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      DURATION_STRING.test(node.text)
    )
      found.push(`'${node.text}'`);
    else if (isTextNode(node))
      for (const [match] of node.text.matchAll(LIMIT_IN_TEXT))
        found.push(`"${match}"`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isTextNode(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** A module-level UPPER_CASE const: the one place a limit is named. */
function isNamedConstant(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    CONSTANT_NAME.test(node.name.text) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent)
  );
}

function isLimit(node) {
  const value = Number(node.text.replaceAll('_', ''));
  if (value === 0 || value === 1) return false;
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent)) return false;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken].includes(
        operator,
      ) &&
      UNIT_FACTORS.has(value)
    )
      return false;
    // Bit widths and masks are a format's layout, not a limit.
    if (BIT_OPERATORS.has(operator)) return false;
  }
  return true;
}

function literalText(node) {
  const parent = node.parent;
  return ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.MinusToken
    ? `-${node.text}`
    : node.text;
}

export function validateBackendLimits(written) {
  const findings = [];
  const seen = new Set();
  for (const [file, literals] of written)
    for (const literal of literals) {
      const key = `${file}: ${literal}`;
      const wholeFile = `${file}: *`;
      seen.add(Object.hasOwn(NOT_LIMITS, wholeFile) ? wholeFile : key);
      if (
        !Object.hasOwn(NOT_LIMITS, key) &&
        !Object.hasOwn(NOT_LIMITS, wholeFile)
      )
        findings.push(
          `${key}: name this limit as a constant at its owner (AGENTS.md "Where code lives"), or list it in NOT_LIMITS with a reason.`,
        );
    }
  for (const key of Object.keys(NOT_LIMITS))
    if (!seen.has(key))
      findings.push(`${key}: no longer written; remove it from NOT_LIMITS.`);
  return findings;
}

/** A reworked package dropped from the check since it began. */
export function validateLimitsChecked(checked = LIMITS_CHECKED) {
  return ORIGINAL_LIMITS_CHECKED.filter(
    (workspace) => !checked.includes(workspace),
  ).map(
    (workspace) =>
      `${workspace}: LIMITS_CHECKED may only grow; put it back and name its limits.`,
  );
}

export async function inspectBackendLimits(root = repositoryRoot) {
  const written = [];
  for (const workspace of LIMITS_CHECKED)
    for (const file of await listSourceFiles(workspace, root))
      written.push([
        file,
        findWrittenLimits(file, await readSource(file, root)),
      ]);
  return [...validateLimitsChecked(), ...validateBackendLimits(written)];
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectBackendLimits(),
    'Reworked backend packages name every limit.',
  );
