import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const entrypoint = fileURLToPath(
  new URL('../../dist/main.js', import.meta.url),
);
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential = `ptx_1.${workspace}.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.${'A'.repeat(43)}`;
const execute = promisify(execFile);
describe('compiled automation process', () => {
  it('shows help with no database, telemetry or automation configuration', async () => {
    const result = await execute(
      process.execPath,
      [entrypoint, 'automation', '--help'],
      { env: {}, timeout: 5000 },
    );
    expect(result.stdout).toContain('HTTP; no operator/database configuration');
    expect(result.stderr).toBe('');
  });
  it('runs with only URL and personal-token environment, and returns safe JSON on authentication failure', async () => {
    let rejected = false;
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      expect(request.headers.cookie).toBeUndefined();
      response.setHeader(
        'Content-Type',
        rejected ? 'application/problem+json' : 'application/json',
      );
      response.statusCode = rejected ? 401 : 200;
      response.end(
        JSON.stringify(
          rejected
            ? {
                type: 'about:blank',
                title: 'Unauthorized',
                status: 401,
                code: 'auth.unauthenticated',
                requestId: 'safe-request',
              }
            : { items: [], nextCursor: null },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('missing server');
      const env = {
        PERTEXO_API_URL: `http://127.0.0.1:${String(address.port)}`,
        PERTEXO_API_TOKEN: credential,
      };
      const args = [
        entrypoint,
        'automation',
        'workflows',
        'list',
        '--workspace',
        workspace,
      ];
      const success = await execute(process.execPath, args, {
        env,
        timeout: 5000,
      });
      expect(JSON.parse(success.stdout)).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(success.stderr).toBe('');
      rejected = true;
      await expect(
        execute(process.execPath, args, { env, timeout: 5000 }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr:
          '{"code":"auth.unauthenticated","detail":"Unauthorized","requestId":"safe-request"}\n',
      });
      await expect(
        execute(process.execPath, [...args, '--token', credential], {
          env,
          timeout: 5000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: `${JSON.stringify({ code: 'cli.invalid_argument', detail: 'Use a supported command and named options. Run automation --help. Tokens are accepted only through PERTEXO_API_TOKEN.' })}\n`,
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
  });
  it('SIGTERM interrupts a real request and closes the process without a credential diagnostic', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('missing server');
    const child = spawn(
      process.execPath,
      [
        entrypoint,
        'automation',
        'runs',
        'start',
        '--workspace',
        workspace,
        '--workflow',
        workspace,
        '--key',
        'interrupted',
      ],
      {
        env: {
          PERTEXO_API_URL: `http://127.0.0.1:${String(address.port)}`,
          PERTEXO_API_TOKEN: credential,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    try {
      await once(server, 'request');
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      expect(await exit).toEqual([1, null]);
      expect(JSON.parse(output)).toMatchObject({
        code: 'cli.transport_failure',
        detail: 'Command interrupted.',
        outcome: 'unknown',
      });
      expect(output).not.toContain(credential);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
