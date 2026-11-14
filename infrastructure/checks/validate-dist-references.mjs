import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** Built-file paths in `file` whose source is missing from its workspace. */
export function unresolvedDistReferences(file, text, exists = existsSync) {
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
    if (!sources.some((source) => exists(path.join(repositoryRoot, source))))
      findings.push(
        `${file}: ${written} names ${workspace}/dist/${built}.${module}js, but ${sources[0]} doesn't exist; a moved source needs this path updated`,
      );
  }
  return findings;
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
