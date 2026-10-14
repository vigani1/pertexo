import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { executeAutomationCommand } from '../src/commands.js';
import { parseAutomationArguments } from '../src/arguments.js';
import type { AutomationHttpClient } from '../src/http.js';
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const etag = `"draft.${'B'.repeat(43)}"`;
const graph = { nodes: [], edges: [], settings: {} };
const manifest = {
  format: 'pertexo.workflow',
  graph,
  requirements: { definitions: [] },
  connectionSlots: [],
};
const fingerprint = `wf-compat:sha256:${'a'.repeat(64)}`;
const exportBody = {
  source: { kind: 'draft' },
  reviewedGraphDigest: 'a'.repeat(64),
};
const previewBody = { manifest, bindings: [] };
describe('automation command behavior', () => {
  it.each([
    {
      args: ['workflows', 'list', '--limit', '7', '--after', 'x y'],
      path: '/workflows?limit=7&after=x+y',
      effect: 'read',
    },
    {
      args: ['workflows', 'get', '--workflow', target],
      path: `/workflows/${target}`,
      effect: 'read',
    },
    {
      args: ['workflows', 'draft', '--workflow', target],
      path: `/workflows/${target}/draft`,
      effect: 'read',
    },
    {
      args: [
        'workflows',
        'versions',
        '--workflow',
        target,
        '--version',
        target,
      ],
      path: `/workflows/${target}/versions?versionId=${target}`,
      effect: 'read',
    },
    {
      args: ['workflows', 'export', '--workflow', target, '--etag', etag],
      body: exportBody,
      path: `/workflows/${target}/export`,
      effect: 'read',
    },
    {
      args: ['workflows', 'import-preview'],
      body: previewBody,
      path: '/workflows/import/preview',
      effect: 'read',
    },
    {
      args: ['workflows', 'import', '--key', 'original-import'],
      body: {
        ...previewBody,
        name: 'Reviewed import',
        expectedCompatibilityFingerprint: fingerprint,
      },
      path: '/workflows/import',
      effect: 'write',
    },
    {
      args: [
        'workflows',
        'publish',
        '--workflow',
        target,
        '--key',
        'original-publish',
        '--etag',
        etag,
      ],
      path: `/workflows/${target}/publish`,
      effect: 'write',
    },
    {
      args: ['runs', 'start', '--workflow', target, '--key', 'original-start'],
      body: { input: { value: 'exact' }, expectedPublishedVersionId: target },
      path: `/workflows/${target}/runs`,
      effect: 'write',
    },
    {
      args: ['runs', 'list', '--workflow', target, '--limit', '5'],
      path: `/runs?limit=5&workflowId=${target}`,
      effect: 'read',
    },
    {
      args: ['runs', 'get', '--run', target],
      path: `/runs/${target}`,
      effect: 'read',
    },
    {
      args: ['runs', 'cancel', '--run', target],
      path: `/runs/${target}/cancel`,
      effect: 'write',
    },
  ])(
    'maps $args without changing reviewed intent',
    async ({ args, body, path, effect }) => {
      const dir = await mkdtemp(join(tmpdir(), 'pertexo-command-'));
      try {
        const file = join(dir, 'request.json');
        if (body !== undefined) await writeFile(file, JSON.stringify(body));
        const command = parseAutomationArguments([
          ...args,
          '--workspace',
          workspace,
          ...(body === undefined ? [] : ['--body', file]),
        ]);
        if (command === 'help') throw new Error('unexpected help');
        const request = vi
          .fn<AutomationHttpClient['request']>()
          .mockResolvedValue({ body: { invalid: true }, etag: null });
        await expect(
          executeAutomationCommand(
            { request },
            command,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          code: 'cli.invalid_response',
          uncertain: effect === 'write',
        });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[0]).toMatchObject({
          path: `/v1/workspaces/${workspace}${path}`,
          effect,
          ...(body === undefined ? {} : { body }),
        });
        const headers = request.mock.calls[0]?.[0].headers;
        if ('key' in command)
          expect(headers?.['Idempotency-Key']).toBe(command.key);
        if ('etag' in command) expect(headers?.['If-Match']).toBe(command.etag);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('returns validated JSON and the reviewed draft’s opaque HTTP ETag', async () => {
    const response = {
      workflowId: target,
      revision: 2,
      graph,
      updatedAt: '2026-10-14T00:00:00Z',
      compatibility: { compatible: true, fingerprint, issues: [] },
    };
    const command = parseAutomationArguments([
      'workflows',
      'draft',
      '--workspace',
      workspace,
      '--workflow',
      target,
    ]);
    if (command === 'help') throw new Error('unexpected help');
    const request = vi
      .fn<AutomationHttpClient['request']>()
      .mockResolvedValue({ body: response, etag });
    expect(
      await executeAutomationCommand(
        { request },
        command,
        new AbortController().signal,
      ),
    ).toEqual({ ...response, etag });
  });
  it('refuses missing draft or irrelevant version preconditions and malformed bodies before HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pertexo-command-'));
    try {
      const file = join(dir, 'request.json');
      const request = vi.fn<AutomationHttpClient['request']>();
      for (const [body, args] of [
        [exportBody, []],
        [
          { ...exportBody, source: { kind: 'version', versionId: target } },
          ['--etag', etag],
        ],
        [
          { source: { kind: 'draft' }, reviewedGraphDigest: 'bad' },
          ['--etag', etag],
        ],
      ] as const) {
        await writeFile(file, JSON.stringify(body));
        const command = parseAutomationArguments([
          'workflows',
          'export',
          '--workspace',
          workspace,
          '--workflow',
          target,
          '--body',
          file,
          ...args,
        ]);
        if (command === 'help') throw new Error('unexpected help');
        await expect(
          executeAutomationCommand(
            { request },
            command,
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          code: 'cli.invalid_argument',
          uncertain: false,
        });
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
