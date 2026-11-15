import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  directoryEntries,
  listWorkspaces,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

/** Entry files AGENTS.md keeps in their roles, plus a workspace's config module. */
const ENTRY_FILES = new Set([
  'index.ts',
  'server.ts',
  'main.ts',
  'main.tsx',
  'testing.ts',
  'startup.ts',
  'config.ts',
]);
/** Entries only one workspace has (the database's doors for core and secrets). */
const WORKSPACE_ENTRY_FILES = Object.freeze({
  'packages/database': new Set(['schema.ts', 'primitives.ts', 'platform.ts']),
});

/** The named core concepts a workspace keeps beside its entries, each with a reason. */
export const ROOT_CONCEPTS = Object.freeze({
  'packages/policy': {
    'authorization-policy.ts':
      'roles and capabilities, the package’s core table',
    'membership-policy.ts': 'member-management transitions',
    'workspace-status-policy.ts': 'the named workspace status lists',
    'auto-pause-policy.ts': 'the auto-pause ceiling',
    'instance-limits-policy.ts':
      'the instance defaults, kept out of core so startup settings stay light',
  },
  'packages/rate-limit': {
    'rate-limit-policy.ts': 'the budgets every limiter applies',
    'rate-limit.errors.ts': 'the package’s one error family',
    'redis-rate-limit.runtime.ts': 'the package’s one live connection',
  },
  'packages/templates': {
    'catalog.ts': 'the curated examples',
    'curated-template.validation.ts': 'curated manifest verification',
    'https-endpoint.validation.ts': 'the curated HTTPS address grammar',
  },
  'packages/node-catalog': {
    'catalog.ts': 'the platform catalog',
    'browser-catalog.ts': 'the browser projection of the catalog',
    'portable-definition-policy.ts': 'import and export admission',
    'curated-template-policy.ts': 'curated setup against node schemas',
    'node-catalog.errors.ts': 'the package’s one error family',
  },
  'packages/artifact-store': {
    'artifact.store.ts': 'the store facade every caller uses',
    'artifact-identity.ts': 'artifact identity and storage keys',
    'artifact-store.errors.ts': 'the package’s one error family',
  },
  'packages/database': {
    'migrate.ts':
      'the migration process entry compose and db:migrate run from dist',
    'migration-history.ts':
      'the single-server deploy mounts its dist file alone, so its path is a deploy contract',
  },
  'packages/workflow-engine': {
    'workflow-execution.ts': 'the engine’s state vocabulary every area reads',
    'workflow-engine.errors.ts': 'the engine’s one error family',
  },
  'apps/api': {
    'app.ts':
      'builds and starts the HTTP application; the production-image check loads its built file',
    'app.module.ts': 'the Nest composition root',
  },
  'apps/worker': {
    'worker-application.ts':
      'starts and stops the worker; the production-image check loads its built file',
    'worker.module.ts': 'the Nest composition root',
  },
  'apps/cli': {
    'run-automation-cli.ts': 'one CLI run: parse, configure, execute, print',
  },
  'apps/ops': {
    'execute-operator-command.ts':
      'runs one operator command; the production-image check loads its built file',
    'operator-config.ts': 'the operator settings',
  },
  'apps/code-runner': {
    'runner-application.ts':
      'checks isolation, then starts the task pool and the socket',
  },
});

/** Findings for one workspace's direct `src` files. */
export function validatePackageRoot(workspace, files) {
  const concepts = ROOT_CONCEPTS[workspace] ?? {};
  const ownEntries = WORKSPACE_ENTRY_FILES[workspace] ?? new Set();
  const loose = files.filter(
    (file) =>
      !ENTRY_FILES.has(file) &&
      !ownEntries.has(file) &&
      !Object.hasOwn(concepts, file),
  );
  const findings = [];
  for (const file of loose)
    findings.push(
      `${workspace}/src/${file}: a src root holds entry files and named core concepts; move it into an area or list it with a reason in ROOT_CONCEPTS.`,
    );
  for (const file of Object.keys(concepts))
    if (!files.includes(file))
      findings.push(
        `${workspace}/src/${file}: listed in ROOT_CONCEPTS but missing; remove the entry.`,
      );
  return findings;
}

export async function inspectPackageRoots(root = repositoryRoot) {
  const findings = [];
  for (const workspace of await listWorkspaces(root)) {
    const entries = await directoryEntries(path.join(root, workspace, 'src'));
    const files = entries
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => entry.name);
    findings.push(...validatePackageRoot(workspace, files));
  }
  return findings;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectPackageRoots(),
    'Every reworked src root holds only entry files and its named concepts.',
  );
