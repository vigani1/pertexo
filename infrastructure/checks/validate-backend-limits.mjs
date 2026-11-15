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
import { isHttpStatus } from './http-status-positions.mjs';

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
  'apps/cli',
  'apps/ops',
  'apps/code-runner',
  'apps/worker',
  'apps/api',
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
const UNITS = String.raw`(?:milliseconds?|ms|seconds?|minutes?|hours?|days?|bytes?|characters?|KB|KiB|MB|MiB|GB|GiB)`;
// A limit written into text: "30000 milliseconds", "32-byte", "five minutes".
// An encoding's name ("UTF-8 bytes", "UTF-16 units") is not a limit.
const LIMIT_IN_TEXT = new RegExp(
  String.raw`(?<!UTF-)\b(?:\d[\d,_]*|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|sixty|ninety)[\s-]${UNITS}\b`,
  'giu',
);
const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/**
 * Literal limits in one file: numbers and duration strings outside a named
 * constant's value, and limits written into text anywhere.
 */
export function findWrittenLimits(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node, named) => {
    if (ts.isTypeNode(node)) return;
    if (!named && ts.isNumericLiteral(node) && isLimit(node))
      found.push(literalText(node));
    else if (
      !named &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      DURATION_STRING.test(node.text)
    )
      found.push(`'${node.text}'`);
    // Text inside a constant's table copies a limit; only a constant whose
    // value is the text itself (`sql.raw("interval '60 seconds'")`) names it.
    else if (isTextNode(node) && !(named && isWholeConstantValue(node)))
      for (const [match] of node.text.matchAll(LIMIT_IN_TEXT))
        found.push(`"${match}"`);
    const constant = named || isNamedConstant(node);
    ts.forEachChild(node, (child) =>
      visit(child, constant && namesChild(node, child)),
    );
  };
  visit(source, false);
  return found;
}

/** The one file that may write a byte unit after a number it computed. */
export const BYTE_SIZE_OWNER = 'packages/node-sdk/src/values/byte-size.ts';
// A unit written straight after an interpolated number: `${…} KB`.
const UNIT_AFTER_VALUE = /^\s?(B|KB|KiB|MB|MiB|GB|GiB)\b/u;

/**
 * Byte sizes and counts in text written by hand instead of through
 * `formatByteSize` and `formatCount`.
 */
export function findHandWrittenByteUnits(file, text) {
  if (file === BYTE_SIZE_OWNER) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'toLocaleString'
    )
      found.push(
        `${file}: .toLocaleString: write counts with formatCount (${BYTE_SIZE_OWNER}).`,
      );
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

/**
 * Whether a constant's child still belongs to the value it names. A schema's
 * bounds (`z.string().max(64)`, `textSchema.max(255)`) and a function's body
 * are code inside the constant, so they write their own literals; tables built
 * with `Object.freeze`, `new Map`, `sql.raw` or a helper stay named.
 */
function namesChild(parent, child) {
  if (ts.isFunctionLike(parent)) return false;
  return !(
    ts.isCallExpression(parent) &&
    child !== parent.expression &&
    isSchemaChain(parent.expression)
  );
}

// The text is the constant's value, at most wrapped in calls: not one of its
// table's entries.
function isWholeConstantValue(node) {
  let current = node;
  while (
    ts.isCallExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent)
  )
    current = current.parent;
  return isNamedConstant(current.parent);
}

const SCHEMA_ROOT = /^(?:z|\w+Schema)$/u;

// `z.number().int().max`: a method reached through calls from `z` or a schema.
function isSchemaChain(callee) {
  let current = callee;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))
    current = current.expression;
  return (
    current !== callee &&
    ts.isIdentifier(current) &&
    SCHEMA_ROOT.test(current.text)
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
