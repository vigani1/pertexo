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
    `#!${process.execPath}
const fs = require('node:fs');
const mode = process.argv[2];
const size = mode === 'small' || mode === 'stderr-only' ? 12 : 2 * 1024 * 1024;
fs.writeFileSync(1, Buffer.alloc(size, 'o'));
if (['progress', 'dump', 'dump-failure', 'stderr-only'].includes(mode)) {
  fs.writeFileSync(2, Buffer.alloc(2 * 1024 * 1024, 'e'));
}
if (mode === 'dump-failure') {
  fs.writeFileSync(2, 'owned dump failure diagnostic');
  process.exitCode = 23;
}
`,
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
      code: 'DOCKER_OUTPUT_LIMIT',
      message:
        'Docker stdout exceeded the 65536-byte capture limit. Use a streamed output file for larger results.',
    });
  });
});

test('recovery dump streams 2 MiB of stderr with stdout directed to the dump file', () => {
  fixture((directory, env) => {
    const output = openSync(join(directory, 'database.dump'), 'w');
    try {
      docker(['dump'], {
        env,
        encoding: null,
        stdio: ['ignore', output, 'pipe'],
      });
    } finally {
      closeSync(output);
    }
    assert.equal(
      readFileSync(join(directory, 'database.dump')).length,
      2 * 1024 * 1024,
    );
  });
});

test('recovery dump preserves the failed exit and a bounded useful stderr diagnostic', () => {
  fixture((directory, env) => {
    const output = openSync(join(directory, 'database.dump'), 'w');
    try {
      assert.throws(
        () =>
          docker(['dump-failure'], {
            env,
            encoding: null,
            stdio: ['ignore', output, 'pipe'],
          }),
        (error) => {
          assert.equal(error.status, 23);
          assert.notEqual(error.code, 'ENOBUFS');
          assert.match(error.message, /owned dump failure diagnostic/);
          assert.match(String(error.stderr), /stderr truncated/);
          assert.ok(error.stderr.length < 66 * 1024);
          return true;
        },
      );
    } finally {
      closeSync(output);
    }
  });
});

test('recovery captures a small answer even when stderr exceeds 2 MiB', () => {
  fixture((_directory, env) => {
    assert.equal(
      docker(['stderr-only'], { env, captureOutput: true }),
      'o'.repeat(12),
    );
  });
});
