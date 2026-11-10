import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createNotices,
  requireAllowedLicense,
} from './third-party-notices.mjs';

test('rejects restricted, unknown and missing licenses', () => {
  for (const license of [
    'GPL-3.0',
    'AGPL-3.0',
    'LGPL-3.0',
    'MPL-2.0',
    'Unknown',
    '',
  ])
    assert.throws(
      () => requireAllowedLicense('new-library', license),
      /Review required/u,
    );
});

test('allows permissive dependencies and only reasoned package exceptions', () => {
  for (const license of [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'Zlib',
  ])
    assert.doesNotThrow(() => requireAllowedLicense('library', license));
  assert.match(
    requireAllowedLicense('@fontsource-variable/inter', 'OFL-1.1'),
    /fonts/u,
  );
  assert.throws(
    () => requireAllowedLicense('another-font', 'OFL-1.1'),
    /Review required/u,
  );
});

test('notices retain the published copyright and license text', () => {
  const path = mkdtempSync(join(tmpdir(), 'pertexo-notices-'));
  try {
    writeFileSync(
      join(path, 'LICENSE'),
      'Copyright 2026 Example\nPermission is hereby granted',
    );
    const notices = createNotices({
      MIT: [
        {
          name: 'example',
          versions: ['1.2.3'],
          paths: [path],
          homepage: 'https://example.test',
        },
      ],
    });
    assert.match(notices, /example 1\.2\.3/u);
    assert.match(
      notices,
      /Copyright 2026 Example\nPermission is hereby granted/u,
    );
    assert.match(notices, /https:\/\/example.test/u);
  } finally {
    rmSync(path, { recursive: true });
  }
});

test('a symlinked CLI invocation still rejects a restricted dependency', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-license-cli-'));
  try {
    const script = join(directory, 'check.mjs');
    symlinkSync(
      fileURLToPath(new URL('./third-party-notices.mjs', import.meta.url)),
      script,
    );
    const inventory = {
      'GPL-3.0': [{ name: 'restricted', versions: ['1'], paths: [] }],
    };
    writeFileSync(
      join(directory, 'pnpm'),
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(inventory))});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Review required: restricted declares GPL-3.0/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
