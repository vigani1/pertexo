import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

/** Packages whose steps may hold a resolved connection's secret. */
export const STEP_PACKAGES = Object.freeze([
  'packages/node-sdk',
  'packages/nodes-core',
  'packages/integrations',
]);

/** The one file that opens a connection secret: it parses it and always zeroes it. */
export const SECRET_OWNER =
  'packages/node-sdk/src/execution/connection-secret.ts';

/** Reads of a `secret` field in one file: `x.secret`, `x['secret']` or `{ secret }`. */
export function findSecretReads(file, text) {
  if (file === SECRET_OWNER) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const at = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node) => {
    const read =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'secret') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'secret') ||
      (ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(source) === 'secret' &&
        ts.isObjectBindingPattern(node.parent));
    if (read) found.push(`${file}:${String(at(node))}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function validateSecretReads(reads) {
  return reads.map(
    (place) =>
      `${place}: open a connection secret only through withProviderCredential (${SECRET_OWNER}), which zeroes it.`,
  );
}

export async function inspectConnectionSecrets(root = repositoryRoot) {
  const reads = [];
  for (const workspace of STEP_PACKAGES)
    for (const file of await listSourceFiles(workspace, root))
      reads.push(...findSecretReads(file, await readSource(file, root)));
  return validateSecretReads(reads);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectConnectionSecrets(),
    'Step packages open connection secrets only through withProviderCredential.',
  );
