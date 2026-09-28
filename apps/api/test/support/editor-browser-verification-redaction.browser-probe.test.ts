import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { ownEditorBrowserProcess } from './editor-browser-process.js';

it('the actual Playwright reporter omits a failed verification URL and token', async () => {
  const webDirectory = new URL('../../../web/', import.meta.url);
  const webRequire = createRequire(new URL('package.json', webDirectory));
  const token = `redaction-${randomUUID()}`;
  const target = `http://127.0.0.1:1/?verificationToken=${token}`;
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
        PERTEXO_LIVE_MAIL_ORIGIN: undefined,
        PERTEXO_VERIFICATION_REDACTION_PROBE: 'true',
        PERTEXO_VERIFICATION_REDACTION_TARGET: target,
      },
    },
  );
  const owner = ownEditorBrowserProcess(child, 'browser');
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(1);
    expect(output).toContain(
      'Could not open the verification link; sensitive navigation details omitted.',
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain(target);
    expect(output).not.toContain('Call log:');
  } finally {
    await expect(owner.close()).rejects.toThrow(
      /Browser shutdown is unconfirmed/u,
    );
  }
}, 15_000);
