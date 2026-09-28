import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { ownEditorBrowserProcess } from './editor-browser-process.js';

it.each([
  'initial-launch-failure',
  'restarted-launch-failure',
  'normal',
] as const)(
  'tracks pending browser lifetime: %s',
  async (scenario) => {
    const pending = new Set<string>();
    const receipts: { phase: string; instanceId: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 128) request.destroy();
      });
      request.on('end', () => {
        try {
          const value: unknown = JSON.parse(body);
          if (
            typeof value !== 'object' ||
            value === null ||
            !('instanceId' in value) ||
            typeof value.instanceId !== 'string'
          )
            throw new Error('Invalid lifetime receipt');
          const phase = request.url ?? '';
          if (phase === '/browser-opened') pending.add(value.instanceId);
          else if (phase === '/browser-disposed') {
            if (!pending.delete(value.instanceId))
              throw new Error('Unknown lifetime receipt');
          } else throw new Error('Unknown phase');
          receipts.push({ phase, instanceId: value.instanceId });
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Isolated receipt listener is unavailable');
    const webDirectory = new URL('../../../web/', import.meta.url);
    const webRequire = createRequire(new URL('package.json', webDirectory));
    const child = spawn(
      process.execPath,
      [
        webRequire.resolve('@playwright/test/cli'),
        'test',
        '--config',
        'playwright.live.config.ts',
        '--reporter=line',
      ],
      {
        cwd: webDirectory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
          PERTEXO_BROWSER_LIFETIME_PROBE: scenario,
          PERTEXO_VERIFICATION_REDACTION_PROBE: undefined,
        },
      },
    );
    const owner = ownEditorBrowserProcess(child, 'browser', {
      browserDisposed: () => receipts.length > 0 && pending.size === 0,
    });
    // Drain reporter pipes without retaining its intentionally failing output.
    child.stdout.resume();
    child.stderr.resume();
    let ownerChecked = false;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code).toBe(scenario === 'normal' ? 0 : 1);
      expect(receipts.map(({ phase }) => phase)).toEqual(
        scenario === 'restarted-launch-failure'
          ? ['/browser-opened', '/browser-disposed', '/browser-opened']
          : scenario === 'normal'
            ? ['/browser-opened', '/browser-disposed']
            : ['/browser-opened'],
      );
      expect(pending.size).toBe(scenario === 'normal' ? 0 : 1);
      if (scenario === 'restarted-launch-failure')
        expect(receipts[2]?.instanceId).not.toBe(receipts[0]?.instanceId);
      if (scenario === 'normal') await owner.close();
      else
        await expect(owner.close()).rejects.toThrow(
          /Browser shutdown is unconfirmed/u,
        );
      ownerChecked = true;
    } finally {
      if (!ownerChecked) await owner.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  },
  20_000,
);
