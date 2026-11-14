import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readSource, report, repositoryRoot } from './workspace-sources.mjs';

// A path written as a string (a child process importing a built file, a script
// mounting one) isn't followed by renames or the typecheck, and a stale local
// `dist` hides the break until CI builds from scratch.
const scanned = /\.(?:ts|tsx|mts|mjs|js|cjs|sh|ya?ml)$|(?:^|\/)Dockerfile$/u;
// Their samples name made-up packages on purpose.
const fixtureChecks = /^infrastructure\/checks\/[^/]+\.test\.mjs$/u;
const reference =
  /(?<![\w@/.-])((?:\.{1,2}\/)+(?:[\w.-]+\/)*dist\/[\w./-]+\.m?js|(?:apps|packages)\/[\w-]+\/dist\/[\w./-]+\.m?js)/gu;
const workspaceDist = /^((?:apps|packages)\/[\w-]+)\/dist\/(.+)\.(m?)js$/u;

// Backup, storage and encryption scripts are mounted from the host into the
// *running* release's image, which may be an older release. They may load only
// built files that don't move between releases: a package's published entry
// points, or these named internals.
const mountedScript =
  /^infrastructure\/single-server\/(?!test\/)(?:[^/]+\/)*[^/]+\.m?js$/u;
const notMounted = /(?:\.fixture\.mjs|\/qualify\.mjs)$/u;
export const MOUNTED_INTERNALS = Object.freeze({
  'packages/database/dist/migration-history.js':
    'Deploy reads pending migrations with it before the new release starts; it stays at the database root on purpose.',
  'packages/database/dist/config.js':
    'The database settings parser; database exports no config entry yet.',
  'apps/api/dist/platform/config/api-config.js':
    "Storage preflight validates the API's settings; apps have no entry points.",
  'apps/api/dist/platform/config/api-configuration.errors.js':
    "Storage preflight reports the API's settings errors.",
  'apps/worker/dist/config/worker.js':
    "Preflight and runtime verification validate the worker's settings.",
  'apps/worker/dist/mail/system-mail-client.js':
    'Runtime verification builds the mail client the worker uses.',
});

/** Built-file paths in `file` whose source is missing from its workspace. */
export function unresolvedDistReferences(
  file,
  text,
  exists = existsSync,
  entryPoints = packageEntryPoints,
) {
  const findings = [];
  for (const [, written] of text.matchAll(reference)) {
    const resolved = path.posix.normalize(
      written.startsWith('.')
        ? path.posix.join(path.posix.dirname(file), written)
        : written,
    );
    const target = workspaceDist.exec(resolved);
    if (!target) continue;
    const [, workspace, built, module] = target;
    const sources = (module ? ['.mts'] : ['.ts', '.tsx']).map(
      (extension) => `${workspace}/src/${built}${extension}`,
    );
    const builtFile = `${workspace}/dist/${built}.${module}js`;
    if (!sources.some((source) => exists(path.join(repositoryRoot, source))))
      findings.push(
        `${file}: ${written} names ${builtFile}, but ${sources[0]} doesn't exist; a moved source needs this path updated`,
      );
    else if (
      mountedScript.test(file) &&
      !notMounted.test(file) &&
      !entryPoints(workspace).includes(builtFile) &&
      !(builtFile in MOUNTED_INTERNALS)
    )
      findings.push(
        `${file}: ${written} loads ${builtFile}, an internal file that can move between releases; this script runs inside the running release's image, so load a published entry point of ${workspace} instead`,
      );
  }
  return findings;
}

/** A workspace's published entry files, from its package.json exports. */
export function packageEntryPoints(workspace) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, workspace, 'package.json'),
        'utf8',
      ),
    );
  } catch {
    return [];
  }
  return Object.values(manifest.exports ?? {})
    .map((target) =>
      typeof target === 'string' ? target : (target.node ?? target.default),
    )
    .filter((target) => typeof target === 'string')
    .map((target) => path.posix.join(workspace, target));
}

export async function inspectDistReferences(root = repositoryRoot) {
  const files = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => scanned.test(file) && !fixtureChecks.test(file));
  const findings = [];
  for (const file of files)
    findings.push(
      ...unresolvedDistReferences(file, await readSource(file, root)),
    );
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  report(
    await inspectDistReferences(),
    'Every built-file path written as a string has its source.',
  );
