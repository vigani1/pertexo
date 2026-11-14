import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

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
  'packages/artifact-store/src/storage/metadata.ts: 404':
    'S3 answers not-found with HTTP 404',
  'packages/queue/src/jobs/queue-job.schemas.ts: *':
    'the W3C traceparent layout: field offsets and widths',
  'packages/rate-limit/src/limiters/distributed-rate-limiter.ts: 3':
    'the length of the Lua script’s refusal reply',
  'packages/rate-limit/src/limiters/distributed-rate-limiter.ts: 6':
    'the length of the Lua script’s admission reply',
  'packages/templates/src/catalog.ts: 2': 'template versions',
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
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isNamedConstant(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    CONSTANT_NAME.test(node.name.text) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function isLimit(node) {
  const value = Number(node.text.replaceAll('_', ''));
  if (value === 0 || value === 1) return false;
  const parent = node.parent;
  if (ts.isPrefixUnaryExpression(parent) && value === 1) return false;
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

export async function inspectBackendLimits(root = repositoryRoot) {
  const written = [];
  for (const workspace of LIMITS_CHECKED)
    for (const file of await listSourceFiles(workspace, root))
      written.push([
        file,
        findWrittenLimits(file, await readSource(file, root)),
      ]);
  return validateBackendLimits(written);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectBackendLimits(),
    'Reworked backend packages name every limit.',
  );
