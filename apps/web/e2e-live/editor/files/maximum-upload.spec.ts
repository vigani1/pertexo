import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import { createOwnedHttpConnection } from '../../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
} from '../../support/authoring/single-step';

interface UploadProbe {
  maximumDelayMillis: number;
}
declare global {
  interface Window {
    fileUploadProbe?: UploadProbe;
  }
}

test('hashes and finalizes 10 MB files in both themes at phone, pane and desktop widths', async ({
  page,
  request,
}) => {
  test.skip(
    process.env.F45_RELEASE_QUALIFICATION !== 'true',
    'Manual maximum-size browser resource qualification',
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), 'pertexo-browser-upload-'),
  );
  const filename = path.join(directory, 'maximum.csv');
  const source = Buffer.from(
    'id,amount\n' +
      Array.from({ length: 100000 }, (_, id) => `${String(id)},2\n`).join(''),
  );
  const bytes = Buffer.concat([
    source,
    Buffer.alloc(10485760 - source.length, 10),
  ]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(filename, bytes);
    bytes.fill(0);
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { workspaceId } = await createOwnedHttpConnection(page, request);
    const workflow = await createEditorWorkflow(
      page,
      workspaceId,
      'Maximum file upload',
    );
    const nodeId = await addSingleStep(
      page,
      workflow,
      /Read file/u,
      'Maximum CSV',
    );
    await page.getByRole('combobox', { name: 'Output', exact: true }).click();
    await page
      .getByRole('option', { name: 'Output pages', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, workflow)).graph.nodes[0]?.config
            .outputMode,
      )
      .toBe('pages');
    // One ordinary account exercises the matrix without bursting sign-up limits.
    for (const theme of ['light', 'dark'] as const)
      for (const width of [375, 990, 1440]) {
        await test.step(`${theme} at ${String(width)}px`, async () => {
          await page.setViewportSize({ width: 1440, height: 800 });
          await page.evaluate((choice) => {
            localStorage.setItem('pertexo.appearance', choice);
          }, theme);
          await page.reload();
          await page.getByTestId(`rf__node-${nodeId}`).focus();
          await page.keyboard.press('Enter');
          await page.setViewportSize({ width, height: 800 });
          if (width < 1024)
            await page
              .getByRole('navigation', { name: 'Editor panels' })
              .getByRole('button', { name: 'Step', exact: true })
              .click();
          const previousRevision = (await readEditorDraft(page, workflow))
            .revision;
          await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
          await page
            .getByRole('button', { name: 'Upload file to read', exact: true })
            .click();
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('HeapProfiler.collectGarbage');
          await page.evaluate(() => {
            const state: UploadProbe = { maximumDelayMillis: 0 };
            window.fileUploadProbe = state;
            let last = performance.now();
            setInterval(() => {
              const now = performance.now();
              state.maximumDelayMillis = Math.max(
                state.maximumDelayMillis,
                now - last - 10,
              );
              last = now;
            }, 10);
          });
          const baseline = await cdp.send('Runtime.getHeapUsage');
          let maximumHeap = baseline.usedSize;
          let maximumBacking = baseline.backingStorageSize;
          let sampling = false;
          const timer = setInterval(() => {
            if (sampling) return;
            sampling = true;
            void cdp
              .send('Runtime.getHeapUsage')
              .then((value) => {
                maximumHeap = Math.max(maximumHeap, value.usedSize);
                maximumBacking = Math.max(
                  maximumBacking,
                  value.backingStorageSize,
                );
              })
              .finally(() => {
                sampling = false;
              });
          }, 20);
          const started = Date.now();
          try {
            // A path avoids adding a base64 copy of the fixture to the browser.
            await page
              .getByLabel('File', { exact: true })
              .setInputFiles(filename);
            await expect(
              page.getByText('File ready', { exact: true }),
            ).toBeVisible({ timeout: 30000 });
          } finally {
            clearInterval(timer);
          }
          const observed = await page.evaluate(() => {
            const state = window.fileUploadProbe;
            if (state === undefined)
              throw new Error('Upload observation missing');
            return {
              maximumDelayMillis: state.maximumDelayMillis,
            };
          });
          console.info(
            'F45 browser maximum upload',
            JSON.stringify({
              theme,
              width,
              elapsedMillis: Date.now() - started,
              maximumHeap,
              baselineHeap: baseline.usedSize,
              maximumBacking,
              baselineBacking: baseline.backingStorageSize,
              heapGrowth: maximumHeap - baseline.usedSize,
              backingGrowth: maximumBacking - baseline.backingStorageSize,
              ...observed,
            }),
          );
          expect(observed.maximumDelayMillis).toBeLessThan(200);
          expect(maximumBacking - baseline.backingStorageSize).toBeLessThan(
            40 * 1048576,
          );
          await page
            .getByRole('button', { name: /^(?:Use|Replace) file$/u })
            .click();
          await expect
            .poll(
              async () =>
                (await readEditorDraft(page, workflow)).graph.nodes[0]
                  ?.inputMappings.file,
            )
            .toMatchObject({
              kind: 'literal',
              value: { kind: 'artifact', byteLength: 10485760, sha256 },
            });
          await expect
            .poll(async () => (await readEditorDraft(page, workflow)).revision)
            .toBeGreaterThan(previousRevision);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > window.innerWidth,
            ),
          ).toBe(false);
          await page.screenshot({
            path: `/tmp/pertexo-f45-release-${theme}-${String(width)}.png`,
          });
          await cdp.detach();
        });
      }
  } finally {
    bytes.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
