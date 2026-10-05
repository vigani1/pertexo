#!/usr/bin/env node

// The changed-scope half of the fast pre-push gate. It lints, typechecks and
// runs the unit tests related to what this branch changed, while CI keeps
// running every suite on every pull request.

import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;
// Type-aware ESLint loads each package's whole project graph; give it the same
// heap as pnpm lint so a scoped run cannot fail where the full one passes.
const LINT_ENVIRONMENT = Object.freeze({
  NODE_OPTIONS: '--max-old-space-size=8192',
});
const TEST_EXCLUDES = [
  '**/*.integration.test.ts',
  '**/*.browser-probe.test.ts',
];
// This fixture requires the unconditional dedicated CI service owner and its
// strict no-skip reporter; the service-free changed gate still lints it.
const INLINE_CALL_HTTP_INTEGRATION_TEST =
  'infrastructure/testing/inline-workflow-call-http.integration.test.mjs';

/** Workspace packages under apps/ and packages/, with their workspace dependencies. */
export function readWorkspacePackages(root) {
  return ['apps', 'packages'].flatMap((parent) => {
    const directory = path.join(root, parent);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const manifestPath = path.join(directory, entry.name, 'package.json');
        if (!existsSync(manifestPath)) return [];
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const dependencies = Object.entries({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        })
          .filter(([, version]) => String(version).startsWith('workspace:'))
          .map(([name]) => name);
        return [
          {
            name: manifest.name,
            directory: `${parent}/${entry.name}`,
            scripts: manifest.scripts ?? {},
            dependencies,
          },
        ];
      });
  });
}

function owningPackage(file, packages) {
  return packages.find((candidate) =>
    file.startsWith(`${candidate.directory}/`),
  );
}

// The changed packages plus every workspace package that depends on one of
// them, directly or through another workspace package.
function withDependents(changed, packages) {
  const affected = new Set(changed);
  const pending = [...changed];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const candidate of packages)
      if (
        !affected.has(candidate) &&
        candidate.dependencies.includes(current.name)
      ) {
        affected.add(candidate);
        pending.push(candidate);
      }
  }
  return [...affected].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * The commands that check a set of changed repository-relative files: lint
 * and related unit tests for each changed package, a typecheck of changed
 * packages and every workspace package that depends on them, and lint plus
 * adjacent node tests for changed infrastructure scripts.
 */
export function planChangedChecks(files, packages, exists = () => true) {
  const changedByPackage = new Map();
  const infrastructure = [];
  for (const file of files) {
    const owner = owningPackage(file, packages);
    if (owner !== undefined) {
      const list = changedByPackage.get(owner) ?? [];
      list.push(file.slice(owner.directory.length + 1));
      changedByPackage.set(owner, list);
    } else if (
      file.startsWith('infrastructure/') ||
      file === 'eslint.config.mjs'
    ) {
      infrastructure.push(file);
    }
  }

  const commands = [];
  for (const [owner, ownFiles] of changedByPackage) {
    const lintable = ownFiles.filter((file) => LINTABLE.test(file));
    if (lintable.length > 0)
      commands.push({
        label: `lint ${owner.name}`,
        cwd: owner.directory,
        command: ['pnpm', 'exec', 'eslint', ...lintable],
        environment: LINT_ENVIRONMENT,
      });
    const testable = ownFiles.filter(
      (file) => LINTABLE.test(file) && !file.endsWith('.d.ts'),
    );
    if (testable.length > 0 && typeof owner.scripts.test === 'string')
      commands.push({
        label: `related unit tests ${owner.name}`,
        cwd: owner.directory,
        command: [
          'pnpm',
          'exec',
          'vitest',
          'related',
          '--run',
          '--passWithNoTests',
          ...TEST_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]),
          ...testable,
        ],
      });
  }
  for (const target of withDependents([...changedByPackage.keys()], packages))
    if (typeof target.scripts.typecheck === 'string')
      commands.push({
        label: `typecheck ${target.name}`,
        cwd: target.directory,
        command: ['pnpm', 'run', 'typecheck'],
      });

  const infrastructureScripts = infrastructure.filter((file) =>
    file.endsWith('.mjs'),
  );
  if (infrastructureScripts.length > 0) {
    commands.push({
      label: 'lint infrastructure',
      cwd: '.',
      command: ['pnpm', 'exec', 'eslint', ...infrastructureScripts],
      environment: LINT_ENVIRONMENT,
    });
    const nodeTests = [
      ...new Set(
        infrastructureScripts.map((file) =>
          file.endsWith('.test.mjs')
            ? file
            : file.replace(/\.mjs$/u, '.test.mjs'),
        ),
      ),
    ].filter(
      (file) => file !== INLINE_CALL_HTTP_INTEGRATION_TEST && exists(file),
    );
    if (nodeTests.length > 0)
      commands.push({
        label: 'infrastructure node tests',
        cwd: '.',
        command: ['node', '--test', ...nodeTests],
      });
  }
  return commands;
}

function git(root, arguments_) {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Files changed since this branch left origin/main, including uncommitted edits. */
export function changedFiles(root) {
  const base =
    git(root, ['merge-base', 'HEAD', 'origin/main']) ??
    git(root, ['rev-parse', 'HEAD~1']);
  if (base === undefined) return undefined;
  const listed = git(root, ['diff', '--name-only', '--diff-filter=ACMR', base]);
  return listed === undefined || listed === ''
    ? []
    : listed.split('\n').filter((file) => file.length > 0);
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const files = changedFiles(root);
  if (files === undefined) {
    console.error(
      'Could not determine the changed files; run pnpm prepush:check instead.',
    );
    process.exitCode = 1;
    return;
  }
  const commands = planChangedChecks(
    files,
    readWorkspacePackages(root),
    (file) => existsSync(path.join(root, file)),
  );
  console.log(
    `Checking ${String(files.length)} changed files with ${String(commands.length)} scoped commands.`,
  );
  for (const step of commands) {
    const startedAt = Date.now();
    console.log(`\n→ ${step.label}`);
    const [executable, ...arguments_] = step.command;
    const result = spawnSync(executable, arguments_, {
      cwd: path.join(root, step.cwd),
      env: { ...process.env, ...step.environment },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`✗ ${step.label} failed`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `✓ ${step.label} (${String(Math.round((Date.now() - startedAt) / 100) / 10)}s)`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  main();
