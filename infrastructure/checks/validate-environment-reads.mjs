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

/** Files that read the environment outside a config module; this list may only shrink. */
export const ENVIRONMENT_READS_PENDING = Object.freeze([
  // NODE_ENV picks the cookie's Secure flag; it belongs in the API's config.
  'apps/api/src/workspaces/http/route.ts',
  // The CLI's entry hands its environment to the parser it runs.
  'apps/cli/src/run-automation-cli.ts',
  // The sandboxed child inherits only PATH; the runner's config should pass it.
  'apps/code-runner/src/process/slot.ts',
]);

/** A config module: `config.ts`, `<subject>-config.ts`, or a file under an app's `config/`. */
export function isConfigModule(file) {
  const name = file.split('/').at(-1) ?? '';
  return (
    /^(?:[a-z0-9-]+-)?config\.tsx?$/u.test(name) ||
    /^apps\/[^/]+\/src\/(?:[^/]+\/)*config\//u.test(file)
  );
}

/** Whether a source text reads `process.env`. */
export function readsEnvironment(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    )
      found = true;
    else if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function validateEnvironmentReads(readers) {
  const findings = [];
  for (const file of readers)
    if (!isConfigModule(file) && !ENVIRONMENT_READS_PENDING.includes(file))
      findings.push(
        `${file}: read process.env only in a config module and pass the typed value inward.`,
      );
  for (const file of ENVIRONMENT_READS_PENDING)
    if (!readers.includes(file))
      findings.push(
        `${file}: no longer reads process.env; remove it from ENVIRONMENT_READS_PENDING.`,
      );
  return findings;
}

export async function inspectEnvironmentReads(root = repositoryRoot) {
  const readers = [];
  for (const workspace of await listWorkspaces(root))
    for (const file of await listSourceFiles(workspace, root))
      if (readsEnvironment(file, await readSource(file, root)))
        readers.push(file);
  return validateEnvironmentReads(readers);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectEnvironmentReads(),
    'Only config modules read process.env.',
  );
