import { execFile } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile),
  entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  run = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const credential = `ptx_1.${workspace}.${run}.${'A'.repeat(43)}`;
async function withApi(
  reply: (response: ServerResponse, url: string) => void,
  test: (env: Record<string, string>) => Promise<void>,
) {
  const server = createServer((request, response) => {
    reply(response, request.url ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No listener');
  try {
    await test({
      PERTEXO_API_URL: `http://127.0.0.1:${String(address.port)}`,
      PERTEXO_API_TOKEN: credential,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}
const send = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    'content-type':
      status >= 400 ? 'application/problem+json' : 'application/json',
  });
  response.end(JSON.stringify(value));
};

describe('compiled CLI qualification', () => {
  it('prints a failed run with exit zero from runs wait', async () => {
    const arrivals: bigint[] = [];
    await withApi(
      (response) => {
        arrivals.push(process.hrtime.bigint());
        send(response, 200, {
          run: { id: run, status: 'failed' },
          futureField: { retained: true },
        });
      },
      async (env) => {
        const result = await execute(
          process.execPath,
          [entry, 'runs', 'wait', '--run', run, '--timeout', '20'],
          { env, timeout: 10000 },
        );
        expect(JSON.parse(result.stdout)).toEqual({
          run: { id: run, status: 'failed' },
          futureField: { retained: true },
        });
        expect(result.stderr).toBe('');
        expect(arrivals).toHaveLength(1);
      },
    );
  });
  it('times out the wait with exit one while leaving the server run alone', async () => {
    const urls: string[] = [];
    await withApi(
      (response, url) => {
        urls.push(url);
        send(response, 200, { run: { status: 'running' } });
      },
      async (env) => {
        await expect(
          execute(
            process.execPath,
            [entry, 'runs', 'wait', '--run', run, '--timeout', '1'],
            { env, timeout: 5000 },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stdout: '',
          stderr: expect.stringContaining('cli.wait_timed_out') as unknown,
        });
        expect(
          urls.every(
            (url) => url === `/v1/workspaces/${workspace}/runs/${run}`,
          ),
        ).toBe(true);
      },
    );
  });
  it.each([
    [400, 1],
    [401, 3],
    [403, 3],
    [404, 4],
    [409, 5],
    [412, 5],
    [428, 5],
    [429, 6],
    [503, 6],
  ] as const)(
    'keeps a future server problem code and maps HTTP %s to exit %s',
    async (status, code) => {
      await withApi(
        (response) => {
          send(response, status, {
            type: 'about:blank',
            status,
            code: 'future.new_problem',
            title: 'Future refusal',
            requestId: 'correlated',
          });
        },
        async (env) => {
          await expect(
            execute(process.execPath, [entry, 'workflows', 'list'], {
              env,
              timeout: 5000,
            }),
          ).rejects.toMatchObject({
            code,
            stdout: '',
            stderr:
              '{"code":"future.new_problem","detail":"Future refusal","requestId":"correlated"}\n',
          });
        },
      );
    },
  );
  it('defaults workspace to the credential and refuses a mismatch before making a request', async () => {
    const urls: string[] = [];
    await withApi(
      (response, url) => {
        urls.push(url);
        send(response, 200, { items: [], future: { kept: 7 } });
      },
      async (env) => {
        const result = await execute(
          process.execPath,
          [entry, 'workflows', 'list'],
          { env, timeout: 5000 },
        );
        expect(JSON.parse(result.stdout)).toEqual({
          items: [],
          future: { kept: 7 },
        });
        expect(urls).toEqual([`/v1/workspaces/${workspace}/workflows?`]);
        await expect(
          execute(
            process.execPath,
            [entry, 'workflows', 'list', '--workspace', run],
            { env, timeout: 5000 },
          ),
        ).rejects.toMatchObject({
          code: 2,
          stderr: expect.stringContaining('workspace must match') as unknown,
        });
        expect(urls).toHaveLength(1);
      },
    );
  });
  it.runIf(process.env.PERTEXO_CLI_TEST_IMAGE !== undefined)(
    'prints its version from the actual built runtime image without configuration',
    async () => {
      const image = process.env.PERTEXO_CLI_TEST_IMAGE;
      if (image === undefined) throw new Error('Image missing');
      const result = await execute(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          image,
          'node',
          'apps/cli/dist/main.js',
          '--version',
        ],
        { timeout: 30000 },
      );
      expect(result.stdout).toBe('pertexo 0.0.0\n');
      expect(result.stderr).toBe('');
    },
  );
});
