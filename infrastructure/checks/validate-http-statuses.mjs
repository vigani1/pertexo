import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import { isHttpStatus, isStatusComparison } from './http-status-positions.mjs';
import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

// The workspaces whose AGENTS.md says statuses are Nest's `HttpStatus`.
const HTTP_STATUS_WORKSPACES = Object.freeze(['apps/api']);

/**
 * Statuses the API sends written as bare numbers: a status property's value,
 * a route's response key or a status schema's literal. Each is Nest's
 * `HttpStatus`; a comparison with a received number, or a schema's class
 * bound, stays a number, since lint refuses mixing the two.
 */
export function findBareHttpStatuses(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isNumericLiteral(node) &&
      isHttpStatus(node, Number(node.text.replaceAll('_', ''))) &&
      !isStatusComparison(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(
        `${file}:${String(line + 1)}: ${node.text}: write the status as HttpStatus (@nestjs/common).`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export async function inspectHttpStatuses(root = repositoryRoot) {
  const findings = [];
  for (const workspace of HTTP_STATUS_WORKSPACES)
    for (const file of await listSourceFiles(workspace, root))
      findings.push(
        ...findBareHttpStatuses(file, await readSource(file, root)),
      );
  return findings;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(await inspectHttpStatuses(), 'The API writes statuses as HttpStatus.');
