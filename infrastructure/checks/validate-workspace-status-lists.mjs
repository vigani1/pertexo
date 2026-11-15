import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  listWorkspaces,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

// The workspace statuses policy names lists of, and the one package that may
// write such a list.
const WORKSPACE_STATUSES = new Set([
  'active',
  'suspended',
  'pending_deletion',
  'purging',
  'deleted',
]);
const POLICY = 'packages/policy/';
const STATUS_LIST_NAME = /workspaceStatus/iu;

/**
 * Workspace-status lists written as array literals: an array of status
 * strings held by something named for workspace statuses. Each must be one of
 * policy's named lists (AGENTS.md: "Workspace status lists").
 */
export function findWorkspaceStatusLists(file, text) {
  if (file.startsWith(POLICY)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node) && isStatusList(node)) {
      const owner = namedOwner(node);
      if (owner !== undefined && STATUS_LIST_NAME.test(owner)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(
          `${file}:${String(line + 1)}: ${node.getText()}: use policy's named list (ACTIVE_WORKSPACE_STATUSES, BROWSABLE_…, UNPURGED_…, ALL_…).`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isStatusList(node) {
  return (
    node.elements.length > 0 &&
    node.elements.every(
      (element) =>
        ts.isStringLiteralLike(element) && WORKSPACE_STATUSES.has(element.text),
    )
  );
}

// The name of what holds the list, through `c ? x : [...]`, parentheses and
// type assertions; for `statuses ?? [...]`, the fallback's own name counts.
function namedOwner(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === current &&
      STATUS_LIST_NAME.test(parent.left.getText())
    )
      return parent.left.getText();
    if (
      ts.isConditionalExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
        ].includes(parent.operatorToken.kind))
    ) {
      current = parent;
      continue;
    }
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertyDeclaration(parent)) &&
      parent.name !== undefined &&
      !ts.isComputedPropertyName(parent.name)
    )
      return parent.name.getText();
    return undefined;
  }
}

export async function inspectWorkspaceStatusLists(root = repositoryRoot) {
  const findings = [];
  for (const workspace of await listWorkspaces(root))
    for (const file of await listSourceFiles(workspace, root))
      findings.push(
        ...findWorkspaceStatusLists(file, await readSource(file, root)),
      );
  return findings;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectWorkspaceStatusLists(),
    "Workspace status lists are policy's named constants.",
  );
