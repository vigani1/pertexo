import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAutomationArguments } from '../src/arguments.js';
import { parseAutomationHttpConfig } from '../src/config.js';
import { readCommandJson, MAX_COMMAND_BYTES } from '../src/files.js';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const credential = `ptx_1.${workspace}.${target}.${'A'.repeat(43)}`;
const etag = `"draft.${'B'.repeat(43)}"`;
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('automation command input', () => {
  it.each([
    ['workflows', 'list'],
    ['workflows', 'get', '--workflow', target],
    ['workflows', 'draft', '--workflow', target],
    ['workflows', 'versions', '--workflow', target],
    [
      'workflows',
      'export',
      '--workflow',
      target,
      '--body',
      'export.json',
      '--etag',
      etag,
    ],
    ['workflows', 'import-preview', '--body', 'preview.json'],
    ['workflows', 'import', '--body', 'import.json', '--key', 'import-1'],
    [
      'workflows',
      'publish',
      '--workflow',
      target,
      '--etag',
      etag,
      '--key',
      'publish-1',
    ],
    ['runs', 'start', '--workflow', target, '--key', 'run-1'],
    ['runs', 'list'],
    ['runs', 'get', '--run', target],
    ['runs', 'cancel', '--run', target],
  ])('accepts supported command %j', (...args) => {
    expect(
      parseAutomationArguments([...args, '--workspace', workspace]),
    ).toMatchObject({
      operation: args.slice(0, 2).join(' '),
      workspaceId: workspace,
    });
  });
  it.each([
    ['workflows', 'publish', '--workflow', target, '--key', 'publish-1'],
    [
      'workflows',
      'publish',
      '--workflow',
      target,
      '--etag',
      `W/${etag}`,
      '--key',
      'publish-1',
    ],
    ['runs', 'start', '--workflow', target],
    ['workflows', 'import', '--body', 'x.json'],
    ['workflows', 'list', '--run', target],
    ['workflows', 'list', '--limit', '101'],
    [
      'workflows',
      'versions',
      '--workflow',
      target,
      '--version',
      target,
      '--after',
      'cursor',
    ],
    ['workflows', 'list', '--workspace', workspace],
    ['runs', 'get', '--run', 'invalid'],
    ['raw', 'get'],
    ['workflows', 'list', '--token', credential],
  ])(
    'rejects invalid or irrelevant options without echoing them %j',
    (...args) => {
      try {
        parseAutomationArguments([...args, '--workspace', workspace]);
        throw new Error('accepted invalid command');
      } catch (error) {
        expect(error).toMatchObject({ code: 'cli.invalid_argument' });
        expect(String(error)).not.toContain(credential);
      }
    },
  );
  it('offers help without configuration and parses bounded pagination', () => {
    expect(parseAutomationArguments([])).toBe('help');
    expect(parseAutomationArguments(['--help'])).toBe('help');
    expect(
      parseAutomationArguments([
        'runs',
        'list',
        '--workspace',
        workspace,
        '--workflow',
        target,
        '--limit',
        '7',
        '--after',
        'opaque',
      ]),
    ).toMatchObject({
      query: { workflowId: target, limit: 7, after: 'opaque' },
    });
  });
  it.each([
    'https://example.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])('accepts allowed origin %s', (origin) => {
    expect(
      parseAutomationHttpConfig({
        PERTEXO_API_URL: origin,
        PERTEXO_API_TOKEN: credential,
      }),
    ).toEqual({ origin, credential });
  });
  it.each([
    'http://example.com',
    'https://user:password@example.com',
    'https://example.com/v1',
    'https://example.com/?token=x',
    'https://example.com/#x',
    'file:///tmp/a',
    'invalid',
  ])('refuses unsafe origin %s', (origin) => {
    expect(() =>
      parseAutomationHttpConfig({
        PERTEXO_API_URL: origin,
        PERTEXO_API_TOKEN: credential,
      }),
    ).toThrow(expect.objectContaining({ code: 'cli.invalid_config' }));
  });
  it('refuses missing/invalid secrets without including supplied material', () => {
    expect(() =>
      parseAutomationHttpConfig({
        PERTEXO_API_TOKEN: 'private-invalid-secret',
      }),
    ).toThrow('Set PERTEXO_API_TOKEN');
  });
  it('reads ordinary JSON and refuses malformed, oversized and nonregular files promptly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pertexo-cli-'));
    temporary.push(dir);
    const path = join(dir, 'input.json');
    await writeFile(path, '{"input":{"ready":true}}');
    expect(await readCommandJson(path)).toEqual({ input: { ready: true } });
    for (const bytes of [
      Buffer.from('{'),
      Buffer.from([0xff]),
      Buffer.alloc(MAX_COMMAND_BYTES + 1, 32),
    ]) {
      await writeFile(path, bytes);
      await expect(readCommandJson(path)).rejects.toMatchObject({
        code: 'cli.invalid_file',
      });
    }
    await expect(readCommandJson(dir)).rejects.toMatchObject({
      code: 'cli.invalid_file',
    });
    const fifo = join(dir, 'pipe');
    await promisify(execFile)('mkfifo', [fifo]);
    await expect(readCommandJson(fifo)).rejects.toMatchObject({
      code: 'cli.invalid_file',
    });
    await expect(readCommandJson(join(dir, credential))).rejects.toThrow(
      'The input file could not be read',
    );
  });
});
