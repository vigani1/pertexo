import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const key = Buffer.alloc(32, 4).toString('base64');
const privateValue = 'private-rejected-value';
const environment = {
  DATABASE_URL:
    'postgresql://pertexo_app:private-database-password@127.0.0.1:1/pertexo',
  NODE_ENV: 'production',
  OPERATOR_ACTOR_REF: 'operator@example.test',
  OPERATOR_REASON: 'Verified recovery',
  PUBLIC_WEB_ORIGIN: 'https://app.example.test',
  AUTH_MAIL_MODE: 'durable',
  AUTH_MAIL_FROM: 'security@example.test',
  AUTH_MAIL_KEY: key,
  AUTH_MAIL_KEY_VERSION: 'v1',
};
async function run(overrides: Readonly<Record<string, string | undefined>>) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../dist/identity/main.js', import.meta.url)),
      '--email',
      'person@example.test',
    ],
    {
      env: { PATH: process.env.PATH, ...environment, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  await once(child, 'close');
  expect(child.exitCode).toBe(1);
  for (const value of [
    key,
    privateValue,
    'private-database-password',
    'person@example.test',
  ])
    expect(stderr).not.toContain(value);
  return stderr;
}
it.each([
  ['AUTH_MAIL_FROM', privateValue, /email address/i],
  ['AUTH_MAIL_KEY_VERSION', undefined, /version.*letters/i],
  ['AUTH_MAIL_PREVIOUS_KEYS', privateValue, /JSON array/i],
  ['PUBLIC_WEB_ORIGIN', privateValue, /HTTP\(S\) origin/i],
  ['DATABASE_URL', privateValue, /PostgreSQL.*URL/i],
] as const)(
  'compiled recovery names %s and its remedy without credentials',
  async (setting, raw, remedy) => {
    const stderr = await run({ [setting]: raw });
    expect(stderr).toContain(setting);
    expect(stderr).toMatch(remedy);
  },
);
it('distinguishes database failure from configuration refusal without printing driver payloads', async () => {
  const server = createServer((socket) => {
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const stderr = await run({
      DATABASE_URL: `postgresql://pertexo_app:private-database-password@127.0.0.1:${String(port)}/pertexo`,
    });
    expect(stderr).toContain('DATABASE_URL');
    expect(stderr).toMatch(/database.*(access|reachable)/i);
    expect(stderr).not.toContain('configuration is invalid');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
