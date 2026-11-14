import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  entriesAddedSince,
  listWorkspaces,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

// PENDING_DOCS as it stood when the check began; it stays within this list.
const ORIGINAL_PENDING_DOCS = Object.freeze([
  'apps/api',
  'apps/cli',
  'apps/code-runner',
  'apps/ops',
  'apps/worker',
  'packages/contracts',
  'packages/core',
  'packages/database',
  'packages/integrations',
  'packages/node-sdk',
  'packages/nodes-core',
  'packages/workflow-engine',
  'packages/workflow-model',
]);

/** Workspaces still without their AGENTS.md; this list may only shrink. */
export const PENDING_DOCS = Object.freeze([
  'apps/api',
  'apps/cli',
  'apps/code-runner',
  'apps/ops',
  'apps/worker',
  'packages/contracts',
  'packages/core',
  'packages/database',
  'packages/integrations',
  'packages/node-sdk',
  'packages/nodes-core',
  'packages/workflow-engine',
]);

// A link to the root rules from `apps/<name>` or `packages/<name>`.
const ROOT_RULES_LINK = /\]\(\.\.\/\.\.\/AGENTS\.md(?:#[^)]*)?\)/u;

/** Findings for one workspace, given its AGENTS.md text or undefined. */
export function validatePackageDoc(workspace, text) {
  const documented = text !== undefined && ROOT_RULES_LINK.test(text);
  if (PENDING_DOCS.includes(workspace))
    return documented
      ? [`${workspace}: has its AGENTS.md; remove it from PENDING_DOCS.`]
      : [];
  if (text === undefined)
    return [`${workspace}: add an AGENTS.md from the package template.`];
  if (!documented)
    return [
      `${workspace}/AGENTS.md: link the root rules as [root rules](../../AGENTS.md).`,
    ];
  return [];
}

/** A pending list that gained an entry since the check began. */
export function validatePendingDocs(pending = PENDING_DOCS) {
  return entriesAddedSince('PENDING_DOCS', pending, ORIGINAL_PENDING_DOCS);
}

export async function inspectPackageDocs(root = repositoryRoot) {
  const findings = [...validatePendingDocs()];
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
