import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const credential = `ptx_1.${workspace}.${runId}.${'A'.repeat(43)}`;

it.each([
  'headers',
  'body',
  'hung',
  'running',
  'quick',
  'interrupted',
] as const)(
  'bounds the compiled runs wait command with a %s response',
  async (mode) => {
    let requestedAt = 0;
    const methods: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((request, response) => {
      requestedAt = performance.now();
      methods.push(request.method ?? 'missing');
      response.setHeader('Content-Type', 'application/json');
      if (mode === 'body') response.write('{"run":');
      if (mode === 'hung' || mode === 'interrupted') return;
      timers.push(
        setTimeout(
          () => {
            const status = mode === 'running' ? 'running' : 'succeeded';
            response.end(
              mode === 'body'
                ? '{"status":"succeeded"}}'
                : JSON.stringify({ run: { status } }),
            );
          },
          mode === 'quick' || mode === 'running' ? 10 : 1800,
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        'runs',
        'wait',
        '--run',
        runId,
        '--timeout',
        '1',
      ],
      {
        env: {
          PERTEXO_API_URL: `http://127.0.0.1:${String(port)}`,
          PERTEXO_API_TOKEN: credential,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '',
      stdout = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3500);
    if (mode === 'interrupted')
      server.once('request', () => {
        child.kill('SIGINT');
      });
    try {
      await once(child, 'close');
      const elapsed = performance.now() - requestedAt;
      expect(methods).toEqual(['GET']);
      expect(child.signalCode).toBeNull();
      expect(elapsed).toBeLessThan(1500);
      if (mode === 'quick') {
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(stdout) as unknown).toEqual({
          run: { status: 'succeeded' },
        });
        expect(stderr).toBe('');
      } else {
        expect(child.exitCode).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain(
          mode === 'interrupted'
            ? 'Command interrupted.'
            : 'cli.wait_timed_out',
        );
        expect(stderr).not.toContain(credential);
        if (mode !== 'interrupted') {
          expect(stderr).toContain('keeps going');
          expect(stderr).toContain(
            mode === 'running'
              ? 'last reported run status was running'
              : 'No run status was received',
          );
        }
      }
    } finally {
      clearTimeout(watchdog);
      for (const timer of timers) clearTimeout(timer);
      child.kill('SIGKILL');
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  },
  6000,
);
