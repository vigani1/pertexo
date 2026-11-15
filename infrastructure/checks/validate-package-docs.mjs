import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  listWorkspaces,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

// A link to the root rules from `apps/<name>` or `packages/<name>`.
const ROOT_RULES_LINK = /\]\(\.\.\/\.\.\/AGENTS\.md(?:#[^)]*)?\)/u;

/** Findings for one workspace, given its AGENTS.md text or undefined. */
export function validatePackageDoc(workspace, text) {
  if (text === undefined)
    return [`${workspace}: add an AGENTS.md from the package template.`];
  if (!ROOT_RULES_LINK.test(text))
    return [
      `${workspace}/AGENTS.md: link the root rules as [root rules](../../AGENTS.md).`,
    ];
  return [];
}

export async function inspectPackageDocs(root = repositoryRoot) {
  const findings = [];
  for (const workspace of await listWorkspaces(root))
    findings.push(
      ...validatePackageDoc(
        workspace,
        await readOptional(path.join(root, workspace, 'AGENTS.md')),
      ),
    );
  return findings;
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectPackageDocs(),
    'Every app and package has an AGENTS.md linking the root rules.',
  );
