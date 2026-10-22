import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repository = new URL('../../../', import.meta.url);

test('image contexts exclude nested secrets and retain environment examples', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-image-context-'));
  const context = join(directory, 'context');
  const output = join(directory, 'output');
  try {
    await mkdir(join(context, 'apps/api'), { recursive: true });
    await mkdir(join(context, 'infrastructure/single-server'), {
      recursive: true,
    });
    await copyFile(
      new URL('.dockerignore', repository),
      join(context, '.dockerignore'),
    );
    await writeFile(
      join(context, 'Dockerfile'),
      'FROM scratch\nCOPY . /context/\n',
    );
    for (const file of [
      '.env',
      '.env.local',
      'apps/api/.env',
      'apps/api/.env.local',
    ]) {
      await writeFile(
        join(context, file),
        'DUMMY_SECRET=must-not-enter-image\n',
      );
    }
    const examples = [
      '.env.example',
      'apps/api/.env.example',
      'infrastructure/single-server/.env.production.example',
    ];
    for (const file of examples)
      await writeFile(join(context, file), 'EXAMPLE=placeholder\n');
    const built = spawnSync(
      'docker',
      [
        'build',
        '--network=none',
        '--output',
        `type=local,dest=${output}`,
        context,
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(built.status, 0, built.stderr);
    for (const file of [
      '.env',
      '.env.local',
      'apps/api/.env',
      'apps/api/.env.local',
    ]) {
      await assert.rejects(readFile(join(output, 'context', file)), {
        code: 'ENOENT',
      });
    }
    for (const file of examples) {
      assert.equal(
        await readFile(join(output, 'context', file), 'utf8'),
        'EXAMPLE=placeholder\n',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
