import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertOrganizationPreviewPortVacant,
  closeOrganizationBrowserBarriers,
  waitForOwnedOrganizationPreview,
} from './workflow-organization-lifetime.js';

async function healthyListener() {
  const server = createServer((_request, response) => response.end('ready'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No port');
  return {
    port: address.port,
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
  };
}

describe('owned organization browser lifetime', () => {
  it('rejects an existing healthy stale listener rather than accepting its readiness', async () => {
    const listener = await healthyListener();
    try {
      await expect(
        assertOrganizationPreviewPortVacant(listener.port),
      ).rejects.toThrow('Owned preview port occupied');
    } finally {
      await listener.close();
    }
    await expect(
      assertOrganizationPreviewPortVacant(listener.port),
    ).resolves.toBeUndefined();
  });
  it('rejects an exited owned child even when another HTTP listener is healthy', async () => {
    const listener = await healthyListener();
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], {
      stdio: 'ignore',
    });
    try {
      await once(child, 'exit');
      await expect(
        waitForOwnedOrganizationPreview(child, listener.origin),
      ).rejects.toThrow('Owned organization preview exited');
    } finally {
      await listener.close();
    }
  });
  it('accepts HTTP readiness only while its owned child remains alive', async () => {
    const listener = await healthyListener();
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    try {
      await once(child, 'spawn');
      await expect(
        waitForOwnedOrganizationPreview(child, listener.origin),
      ).resolves.toBeUndefined();
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      await listener.close();
    }
  });

  it('rejects a child that exits while the readiness response is pending', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    await once(child, 'spawn');
    const server = createServer((_request, response) => {
      void (async () => {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
        response.end('ready');
      })();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('No port');
      await expect(
        waitForOwnedOrganizationPreview(
          child,
          `http://127.0.0.1:${String(address.port)}`,
        ),
      ).rejects.toThrow('Owned organization preview exited');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
  it('attempts every child closure even when browser proof rejects, then preserves the fixture', async () => {
    const attempted: string[] = [];
    await expect(
      closeOrganizationBrowserBarriers([
        {
          close: () => {
            attempted.push('preview');
            return Promise.resolve();
          },
        },
        {
          close: () => {
            attempted.push('browser');
            return Promise.reject(new Error('missing browser receipt'));
          },
        },
      ]),
    ).rejects.toThrow('Owned browser process proof failed; preserve fixture');
    expect(attempted).toEqual(['browser', 'preview']);
  });
});
