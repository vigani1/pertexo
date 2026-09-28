import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ownEditorBrowserProcess } from './editor-browser-process.js';

function assertBrowserReportIsSafe(output: string, secrets: readonly string[]) {
  if (!output.includes('3 failed'))
    throw new Error('Browser report missing expected failure count.');
  if (
    !output.includes(
      'Owned HTTP credential entry failed; sensitive details omitted.',
    )
  )
    throw new Error('Browser report missing safe credential diagnostic.');
  if (
    !output.includes('Owned webhook sender failed; sensitive details omitted.')
  )
    throw new Error('Browser report missing safe sender diagnostic.');
  if (
    !output.includes(
      'Owned visible credential failure; sensitive details omitted.',
    )
  )
    throw new Error(
      'Browser report missing safe visible credential diagnostic.',
    );
  if (secrets.some((secret) => output.includes(secret)))
    throw new Error('Browser report contains sensitive material.');
  if (output.includes('Call log:'))
    throw new Error('Browser report contains a sensitive call log.');
}

it('a secret-bearing report without a safe marker fails without echoing captured output', () => {
  const secret = `Bearer ${randomUUID()}`;
  let failure: unknown;
  try {
    assertBrowserReportIsSafe(`3 failed\n${secret}`, [secret]);
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof Error).toBe(true);
  if (!(failure instanceof Error))
    throw new Error('Expected safe report failure.');
  expect(
    failure.message === 'Browser report missing safe credential diagnostic.',
  ).toBe(true);
  expect(String(failure).includes(secret)).toBe(false);
  expect(failure.stack?.includes(secret)).toBe(false);
});

async function inspectProbeArtifacts(
  directory: string,
  secrets: readonly string[],
) {
  let fileCount = 0;
  let entryCount = 0;
  const present = secrets.map(() => false);
  async function visit(folder: string, depth = 0) {
    if (depth > 8) throw new Error('Browser probe artifact bounds exceeded.');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > 256)
        throw new Error('Browser probe artifact bounds exceeded.');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:md|json)$/u.test(entry.name))
        throw new Error('Unexpected browser probe artifact type.');
      fileCount += 1;
      if (fileCount > 128 || (await stat(path)).size > 1_048_576)
        throw new Error('Browser probe artifact bounds exceeded.');
      const bytes = await readFile(path);
      secrets.forEach((secret, index) => {
        present[index] ||= bytes.includes(secret);
      });
    }
  }
  await visit(directory);
  return { fileCount, present };
}

it.each([
  {
    guarded: true,
    name: 'guarded reporters and artifacts omit visible credentials',
  },
  {
    guarded: false,
    name: 'isolated unprotected control demonstrates DOM snapshot capture',
  },
])(
  '$name',
  async ({ guarded }) => {
    const webDirectory = new URL('../../../web/', import.meta.url);
    const webRequire = createRequire(new URL('package.json', webDirectory));
    const credential = `Bearer ${randomUUID()}`,
      endpoint = `endpoint-${randomUUID()}`,
      signature = `signature-${randomUUID()}`;
    const outputDirectory = await mkdtemp(
      join(tmpdir(), 'pertexo-http-artifact-probe-'),
    );
    const child = spawn(
      process.execPath,
      [
        webRequire.resolve('@playwright/test/cli'),
        'test',
        '--config',
        'playwright.live.config.ts',
        '--reporter=line',
        '--output',
        outputDirectory,
      ],
      {
        cwd: webDirectory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EDITOR_BROWSER_INTEGRATION: undefined,
          PERTEXO_LIVE_MAIL_ORIGIN: undefined,
          PERTEXO_BROWSER_LIFETIME_PROBE: undefined,
          PERTEXO_VERIFICATION_REDACTION_PROBE: undefined,
          PERTEXO_HTTP_REDACTION_PROBE: 'true',
          PERTEXO_HTTP_REDACTION_SNAPSHOT_CONTROL: guarded
            ? undefined
            : 'unprotected',
          PLAYWRIGHT_NO_COPY_PROMPT: undefined,
          PERTEXO_HTTP_REDACTION_CREDENTIAL: credential,
          PERTEXO_HTTP_REDACTION_ENDPOINT: endpoint,
          PERTEXO_HTTP_REDACTION_SIGNATURE: signature,
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
        child.once('error', () => {
          reject(new Error('Browser reporter child failed to start.'));
        });
        child.once('exit', resolve);
      });
      expect(code).toBe(1);
      assertBrowserReportIsSafe(output, [credential, endpoint, signature]);
      const artifacts = await inspectProbeArtifacts(outputDirectory, [
        credential,
        endpoint,
        signature,
      ]);
      process.stdout.write(
        `${JSON.stringify({ mode: guarded ? 'guarded' : 'unprotected-control', ...artifacts })}\n`,
      );
      expect(artifacts.fileCount > 0).toBe(true);
      expect(artifacts.present).toEqual([!guarded, !guarded, !guarded]);
    } finally {
      try {
        await expect(owner.close()).rejects.toThrow(
          /Browser shutdown is unconfirmed/u,
        );
      } finally {
        // Only this invocation's fresh, mkdtemp-owned probe artifacts are removed.
        await rm(outputDirectory, { recursive: true, force: true });
      }
    }
  },
  15_000,
);
