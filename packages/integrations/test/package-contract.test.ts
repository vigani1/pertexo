import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

describe('integration package exports', () => {
  it('keeps KMS and credential code behind the server-only export', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      browser: Record<string, unknown>;
    };
    expect(packageJson.exports['./server']).toEqual(
      expect.objectContaining({ browser: false }),
    );
    expect(packageJson.browser['./dist/server.js']).toBe(false);
    expect(packageJson.browser['./dist/server-only.js']).toBe(false);
  });

  it('keeps the HTTP Request definition browser-safe and its executor server-only', async () => {
    const [browserEntry, definition, validation, serverEntry] =
      await Promise.all(
        [
          '../src/index.ts',
          '../src/http-request/definition.ts',
          '../src/http-request/validation.ts',
          '../src/server.ts',
        ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
      );
    for (const source of [browserEntry, definition, validation]) {
      expect(source).not.toMatch(/node:/u);
      expect(source).not.toContain('@pertexo/node-sdk/server');
      expect(source).not.toContain('http-request/executor');
    }
    expect(serverEntry).toContain('http-request/executor');
  });

  it('keeps every provider browser entry transitively free of Node and server modules', async () => {
    await expect(
      execFileAsync(process.execPath, [
        resolve(
          packageDirectory,
          '../../infrastructure/browser-entry-dependencies.mjs',
        ),
        '--root',
        resolve(packageDirectory, '../..'),
        'packages/integrations/src/index.ts',
        'packages/integrations/src/email/index.ts',
        'packages/integrations/src/http-request/index.ts',
        'packages/integrations/src/slack/index.ts',
      ]),
    ).resolves.toMatchObject({ stderr: '' });
  });
});
