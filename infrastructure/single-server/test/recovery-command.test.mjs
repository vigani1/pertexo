import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { docker } from '../backup/docker-command.mjs';

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-recovery-output-'));
  writeFileSync(
    join(directory, 'docker'),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst size = process.argv[2] === 'small' ? 12 : 2 * 1024 * 1024;\nfs.writeFileSync(1, Buffer.alloc(size, 'o'));\nif (process.argv[2] === 'progress') fs.writeFileSync(2, Buffer.alloc(size, 'e'));\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: directory + delimiter + process.env.PATH,
  };
  try {
    run(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('recovery commands stream progress larger than the child-process buffer on both channels', () => {
  fixture((directory, env) => {
    const output = openSync(join(directory, 'output'), 'w');
    const errors = openSync(join(directory, 'errors'), 'w');
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { docker } from ${JSON.stringify(new URL('../backup/docker-command.mjs', import.meta.url).href)}; docker(['progress']);`,
        ],
        { env, stdio: ['ignore', output, errors] },
      );
    } finally {
      closeSync(output);
      closeSync(errors);
    }
    assert.equal(
      readFileSync(join(directory, 'output')).length,
      2 * 1024 * 1024,
    );
    assert.equal(
      readFileSync(join(directory, 'errors')).length,
      2 * 1024 * 1024,
    );
  });
});

test('recovery captures only explicitly requested small command answers', () => {
  fixture((_directory, env) => {
    assert.equal(
      docker(['small'], { env, captureOutput: true }),
      'o'.repeat(12),
    );
    assert.throws(() => docker(['large'], { env, captureOutput: true }), {
      code: 'ENOBUFS',
    });
  });
});
