import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';
import { NOT_LIMITS } from './backend-limit-exemptions.mjs';

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
  'packages/nodes-core',
  'packages/integrations',
]);

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

/** The one file that may write a byte unit after a number it computed. */
export const BYTE_SIZE_OWNER = 'packages/node-sdk/src/values/byte-size.ts';
// A unit written straight after an interpolated number: `${…} KB`.
const UNIT_AFTER_VALUE = /^\s?(B|KB|KiB|MB|MiB|GB|GiB)\b/u;

/** Byte sizes in text written by hand instead of through `formatByteSize`. */
export function findHandWrittenByteUnits(file, text) {
  if (file === BYTE_SIZE_OWNER) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const unit = UNIT_AFTER_VALUE.exec(node.text)?.[1];
      if (unit !== undefined)
        found.push(
          `${file}: "\${…} ${unit}": write byte sizes with formatByteSize (${BYTE_SIZE_OWNER}).`,
        );
    }
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
  if (isHttpStatus(node, value)) return false;
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

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const STATUS_NAME = /^(?:status|statusCode)$/u;
const FIRST_HTTP_STATUS = 100;
const LAST_HTTP_STATUS = 599;

/**
 * An HTTP status where HTTP code writes one: compared to something named
 * `status` or `statusCode`, the value of such a property, or a key of a
 * route's `responses`. Naming 200 or 404 there only adds noise; any other
 * three-digit number is still a limit.
 */
function isHttpStatus(node, value) {
  if (
    !Number.isInteger(value) ||
    value < FIRST_HTTP_STATUS ||
    value > LAST_HTTP_STATUS
  )
    return false;
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    COMPARISONS.has(parent.operatorToken.kind)
  ) {
    const other = parent.left === node ? parent.right : parent.left;
    return isStatusName(other);
  }
  if (ts.isPropertyAssignment(parent)) {
    if (parent.initializer === node) return isStatusName(parent.name);
    return parent.name === node && isResponsesObject(parent.parent);
  }
  return isArgumentOfStatusSchema(node);
}

// `status: z.literal(409)` or `status: z.number().min(400).max(599)`: an
// argument of the call chain that is a status property's value.
function isArgumentOfStatusSchema(node) {
  let current = node.parent;
  if (!ts.isCallExpression(current)) return false;
  while (
    ts.isCallExpression(current.parent) ||
    ts.isPropertyAccessExpression(current.parent)
  )
    current = current.parent;
  const owner = current.parent;
  return (
    ts.isPropertyAssignment(owner) &&
    owner.initializer === current &&
    isStatusName(owner.name)
  );
}

function isStatusName(node) {
  if (ts.isIdentifier(node)) return STATUS_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node))
    return STATUS_NAME.test(node.name.text);
  return false;
}

function isResponsesObject(object) {
  const owner = object.parent;
  return (
    ts.isObjectLiteralExpression(object) &&
    ts.isPropertyAssignment(owner) &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === 'responses'
  );
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
  const units = [];
  for (const workspace of LIMITS_CHECKED)
    for (const file of await listSourceFiles(workspace, root)) {
      const text = await readSource(file, root);
      written.push([file, findWrittenLimits(file, text)]);
      units.push(...findHandWrittenByteUnits(file, text));
    }
  return [
    ...validateLimitsChecked(),
    ...validateBackendLimits(written),
    ...units,
  ];
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectBackendLimits(),
    'Reworked backend packages name every limit.',
  );
