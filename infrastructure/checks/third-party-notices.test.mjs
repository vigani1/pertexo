import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createNotices,
  createCopiedSoftwareNotices,
  requireAllowedLicense,
} from './third-party-notices.mjs';

function copiedFixture() {
  return {
    python: {
      name: 'CPython',
      version: '3.0.0',
      archive: 'python-archive',
      sha256: '123',
      license: 'Python-2.0',
      source: 'https://python.org',
      texts: [{ file: 'LICENSE', text: 'Original Python permission text' }],
    },
  };
}
const copiedDockerfile = 'ADD --checksum=sha256:123 python-archive /tmp/python';
test('copied Python notices retain license text and source references', () => {
  const notices = createCopiedSoftwareNotices(
    copiedFixture(),
    copiedDockerfile,
    { pythonLicense: 'Original Python permission text' },
  );
  assert.match(notices, /Original Python permission text/u);
  assert.match(notices, /https:\/\/python.org/u);
  assert.doesNotMatch(notices, /rclone|Go runtime/u);
});
test('changed Python download pins and license require inventory review', () => {
  assert.throws(
    () =>
      createCopiedSoftwareNotices(
        copiedFixture(),
        copiedDockerfile.replace('sha256:123', 'sha256:456'),
      ),
    /changing image\/download pins/u,
  );
  assert.throws(
    () =>
      createCopiedSoftwareNotices(copiedFixture(), copiedDockerfile, {
        pythonLicense: 'Changed license',
      }),
    /Python license changed/u,
  );
});
test('copied software without text or with a restricted license fails', () => {
  const inventory = copiedFixture();
  inventory.python.texts = [];
  assert.throws(
    () => createCopiedSoftwareNotices(inventory, copiedDockerfile),
    /Missing license text/u,
  );
  inventory.python.license = 'LGPL-3.0';
  assert.throws(
    () => createCopiedSoftwareNotices(inventory, copiedDockerfile),
    /Review required/u,
  );
});

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

for (const heading of ['## License', 'License\n-------'])
  test(`notices retain README-only license blocks (${heading.split('\n')[0]})`, () => {
    const path = mkdtempSync(join(tmpdir(), 'pertexo-readme-license-'));
    try {
      writeFileSync(
        join(path, 'README.md'),
        `# Example\nUsage instructions\n\n${heading}\n\nCopyright 2026 README Author\nPermission is hereby granted, free of charge.\n\n## Contributing\nUnrelated instructions`,
      );
      const notices = createNotices({
        MIT: [{ name: 'readme-only', versions: ['1'], paths: [path] }],
      });
      assert.match(
        notices,
        /Copyright 2026 README Author\nPermission is hereby granted/u,
      );
      assert.doesNotMatch(
        notices,
        /Usage instructions|Unrelated instructions/u,
      );
    } finally {
      rmSync(path, { recursive: true });
    }
  });

for (const readme of ['', '## License\n[MIT](https://example.test/license)'])
  test(`missing license text fails even with an allowed identifier (${readme ? 'link only' : 'absent'})`, () => {
    const path = mkdtempSync(join(tmpdir(), 'pertexo-missing-license-'));
    try {
      writeFileSync(join(path, 'README.md'), readme);
      assert.throws(
        () =>
          createNotices({
            MIT: [{ name: 'missing-text', versions: ['1'], paths: [path] }],
          }),
        /Missing license text: missing-text/u,
      );
    } finally {
      rmSync(path, { recursive: true });
    }
  });

test('each installed version retains its own license, including README text after a LICENSE file', () => {
  const first = mkdtempSync(join(tmpdir(), 'pertexo-first-license-'));
  const second = mkdtempSync(join(tmpdir(), 'pertexo-second-license-'));
  try {
    writeFileSync(
      join(first, 'LICENSE'),
      'Copyright First Author\nPermission is hereby granted.',
    );
    writeFileSync(
      join(second, 'README.md'),
      '## License\nCopyright Second Author\nPermission is hereby granted.',
    );
    const notices = createNotices({
      MIT: [
        { name: 'two-versions', versions: ['1', '2'], paths: [first, second] },
      ],
    });
    assert.match(notices, /Copyright First Author/u);
    assert.match(notices, /Copyright Second Author/u);
    writeFileSync(join(second, 'README.md'), 'No license here');
    assert.throws(
      () =>
        createNotices({
          MIT: [
            {
              name: 'two-versions',
              versions: ['1', '2'],
              paths: [first, second],
            },
          ],
        }),
      /Missing license text/u,
    );
  } finally {
    rmSync(first, { recursive: true });
    rmSync(second, { recursive: true });
  }
});

test('a missing-text exception is reasoned and limited to its reviewed version', () => {
  const notices = createNotices({
    MIT: [{ name: 'stackback', versions: ['0.0.2'], paths: [] }],
  });
  assert.match(notices, /Missing-text exception: Vitest test-runner helper/u);
  assert.throws(
    () =>
      createNotices({
        MIT: [{ name: 'stackback', versions: ['0.0.3'], paths: [] }],
      }),
    /Missing license text/u,
  );
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
