import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readSource, report, repositoryRoot } from './workspace-sources.mjs';

// A path written as a string (a child process importing a built file, a script
// mounting one) isn't followed by renames or the typecheck, and a stale local
// `dist` hides the break until CI builds from scratch.
const scanned = /\.(?:ts|tsx|mts|mjs|js|cjs|sh|ya?ml|md)$|(?:^|\/)Dockerfile$/u;
// Workflow steps, shell scripts and documented commands run from the repository
// root, so their `./` paths name files from there, not from the file itself.
const runsFromRoot = /\.(?:ya?ml|sh|md)$|(?:^|\/)Dockerfile$/u;
// The image keeps the repository at /workspace.
const IMAGE_ROOT = '/workspace/';
// Their samples name made-up packages on purpose.
const fixtureChecks = /^infrastructure\/checks\/[^/]+\.test\.mjs$/u;
const reference =
  /(?<![\w@/.-])(\/workspace\/(?:apps|packages)\/[\w-]+\/dist\/[\w./-]+\.m?js|(?:\.{1,2}\/)+(?:[\w.-]+\/)*dist\/[\w./-]+\.m?js|(?:apps|packages)\/[\w-]+\/dist\/[\w./-]+\.m?js)/gu;
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

/**
 * Built files only older releases have, named on purpose where a command may
 * run in an older image. Each names the file, the workspace and the built
 * module (without `dist/` or extension), with the reason.
 */
export const OLDER_RELEASE_BUILDS = Object.freeze([
  {
    file: 'docs/operations/upgrading.md',
    workspace: 'packages/database',
    built: 'migrations',
    reason:
      "The migration command may run in a v0.2.0 image, whose /platform entry doesn't export the runner.",
  },
]);

function resolveReference(file, written) {
  if (written.startsWith(IMAGE_ROOT)) return written.slice(IMAGE_ROOT.length);
  if (written.startsWith('.') && !runsFromRoot.test(file))
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), written),
    );
  return path.posix.normalize(written);
}

/** Built-file paths in `file` whose source is missing from its workspace. */
export function unresolvedDistReferences(
  file,
  text,
  exists = existsSync,
  entryPoints = packageEntryPoints,
) {
  const findings = [];
  for (const [, written] of text.matchAll(reference)) {
    const target = workspaceDist.exec(resolveReference(file, written));
    if (!target) continue;
    const [, workspace, built, module] = target;
    const sources = (module ? ['.mts'] : ['.ts', '.tsx']).map(
      (extension) => `${workspace}/src/${built}${extension}`,
    );
    const builtFile = `${workspace}/dist/${built}.${module}js`;
    if (
      OLDER_RELEASE_BUILDS.some(
        (older) =>
          older.file === file &&
          older.workspace === workspace &&
          older.built === built,
      )
    )
      continue;
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
  for (const older of OLDER_RELEASE_BUILDS) {
    const source = files.includes(older.file)
      ? await readSource(older.file, root)
      : '';
    if (!source.includes(`${older.workspace}/dist/${older.built}.`))
      findings.push(
        `${older.file}: no longer names ${older.workspace}'s built ${older.built} module; remove its older-release allowance`,
      );
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  report(
    await inspectDistReferences(),
    'Every built-file path written as a string has its source.',
  );
