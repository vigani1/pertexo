import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { uncoveredComposeFiles } from './dependabot-coverage.mjs';

test('every shipped Compose manifest is covered by Dependabot', () => {
  const { updates } = parse(readFileSync('.github/dependabot.yml', 'utf8'));
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  assert.deepEqual(
    uncoveredComposeFiles(files, updates),
    [],
    'Add the missing Compose directories to the existing grouped Dependabot entry',
  );
});

test('a new distribution directory is rejected until its Compose file is covered', () => {
  const files = [
    'compose.yaml',
    'infrastructure/new-distribution/compose.yaml',
    'docs/compose.md',
  ];
  const update = { 'package-ecosystem': 'docker-compose', directories: ['/'] };
  assert.deepEqual(uncoveredComposeFiles(files, [update]), [
    'infrastructure/new-distribution/compose.yaml',
  ]);
  assert.deepEqual(
    uncoveredComposeFiles(files, [
      { ...update, directories: ['/', '/infrastructure/new-distribution'] },
    ]),
    [],
  );
});

test('coverage supports configured directory globs and Compose filename variants', () => {
  assert.deepEqual(
    uncoveredComposeFiles(
      [
        'infrastructure/new/docker-compose.yml',
        'infrastructure/other/compose.production.yaml',
        'apps/demo/compose.yaml',
      ],
      [
        {
          'package-ecosystem': 'docker-compose',
          directories: ['/infrastructure/*'],
        },
      ],
    ),
    ['apps/demo/compose.yaml'],
  );
});
