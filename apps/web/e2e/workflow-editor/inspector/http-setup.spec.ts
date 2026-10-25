import { httpMultipartConfigSchema } from '@pertexo/integrations';

import { expect, test } from '../../support/fixtures';

import { addCsrfCookie, editorUrl } from '../support';

import {
  httpDefinition,
  httpDraft,
  installHttp,
  openSetup,
  savedConfig,
  savedHttpNode,
} from './http-setup/fixture';

if (httpDefinition === undefined)
  throw new Error('HTTP definition is required');

for (const width of [390, 1280]) {
  test(`puts credentials first and saves human sizes without losing JSON settings at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = httpDraft();
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    const picker = page.getByLabel('HTTP connection', { exact: true });
    await expect(picker).toContainText('Status API');
    const pickerBox = await picker.boundingBox();
    const methodBox = await page
      .getByLabel('Method', { exact: true })
      .boundingBox();
    if (pickerBox === null || methodBox === null)
      throw new Error('Setup controls must be visible');
    expect(pickerBox.y + pickerBox.height).toBeLessThan(methodBox.y);
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    const inline = page.getByLabel('Store as a file above (in kilobytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1');
    await expect(inline).toHaveValue('64');
    await expect(page.getByText('That’s 1 MB. Up to 10 MB.')).toHaveCount(0);
    await response.fill('1.1');
    await expect(response).toBeFocused();
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(1_153_434);
    await inline.fill('64.001');
    await expect
      .poll(() => savedConfig(remote).inlineResponseBytes)
      .toBe(65_537);
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
    await page.reload();
    await openSetup(page, width);
    await expect(response).toHaveValue('1.1');
    await expect(inline).toHaveValue('64.001');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('2.1');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(2_202_010);
    await response.fill('11');
    await response.press('Tab');
    await expect(
      page.getByText('Largest response can be at most 10 MB.'),
    ).toBeVisible();
    expect(savedConfig(remote).maxResponseBytes).toBe(2_202_010);
    await response.fill('10');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('10');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(10_485_760);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test(`preserves an odd byte count and readonly setup at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = httpDraft(1_048_577);
    await installHttp(page, remote, false);
    await page.goto(editorUrl);
    await openSetup(page, width);
    await expect(
      page.getByLabel('HTTP connection', { exact: true }),
    ).toBeDisabled();
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1.000001');
    await expect(response).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'Increase Largest response',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'New HTTP connection' }),
    ).toHaveCount(0);
    expect(savedConfig(remote).maxResponseBytes).toBe(1_048_577);
    expect(remote.revision).toBe(1);
  });
}

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440]) {
    test(`keeps multipart values stable through reorder, cancel, undo and reload in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await page.setViewportSize({ width, height: 768 });
      await addCsrfCookie(context);
      const remote = httpDraft();
      const initial = savedHttpNode(remote);
      remote.graph = {
        ...remote.graph,
        nodes: [
          {
            ...initial,
            config: { ...initial.config, method: 'POST' },
            inputMappings: {
              body: {
                kind: 'literal',
                value: { encoding: 'utf8', value: 'original' },
              },
            },
          },
        ],
      };
      await installHttp(page, remote);
      await page.goto(editorUrl);
      await openSetup(page, width);
      await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
      await page
        .getByRole('button', { name: 'Form parts', exact: true })
        .click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(savedHttpNode(remote).inputMappings).toHaveProperty('body');
      await page
        .getByRole('button', { name: 'Form parts', exact: true })
        .click();
      await page.getByRole('button', { name: 'Replace', exact: true }).click();
      await expect(
        page.getByText(/The whole request must fit in 10 MB/u),
      ).toBeVisible();
      const first = page.getByRole('group', { name: /^Part 1:/u });
      await first.getByLabel('Field name', { exact: true }).fill('title');
      await first.getByLabel('Value', { exact: true }).fill('first');
      await page
        .getByRole('button', { name: 'Add text part', exact: true })
        .click();
      const second = page.getByRole('group', { name: /^Part 2:/u });
      await second.getByLabel('Field name', { exact: true }).fill('title');
      await second.getByLabel('Value', { exact: true }).fill('second');
      await expect
        .poll(() => JSON.stringify(savedHttpNode(remote).inputMappings))
        .toContain('second');
      const before = structuredClone(savedHttpNode(remote));
      const originalParts = httpMultipartConfigSchema.parse(
        before.config.multipart,
      ).parts;
      const reorderedParts = [originalParts[1], originalParts[0]];
      const readParts = () =>
        httpMultipartConfigSchema.parse(savedConfig(remote).multipart).parts;
      await second
        .getByRole('button', { name: 'Move part up', exact: true })
        .press('Enter');
      await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
        'second',
      );
      await expect(
        first.getByLabel('Field name', { exact: true }),
      ).toBeFocused();
      await expect.poll(readParts).toEqual(reorderedParts);
      await page.getByRole('tab', { name: 'Inputs', exact: true }).focus();
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(readParts).toEqual(originalParts);
      await page.getByRole('tab', { name: 'Inputs', exact: true }).focus();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
        'second',
      );
      await expect.poll(readParts).toEqual(reorderedParts);
      const secondKey = Object.entries(before.inputMappings).find(
        ([, value]) => value.kind === 'literal' && value.value === 'second',
      )?.[0];
      if (secondKey === undefined) throw new Error('Second value missing');
      await expect
        .poll(() => savedHttpNode(remote).inputMappings[secondKey])
        .toEqual({ kind: 'literal', value: 'second' });
      await page.getByRole('button', { name: 'Raw body', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
        'second',
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.reload();
      await openSetup(page, width);
      await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
      await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
        'second',
      );
      await first
        .getByRole('button', { name: 'Remove part', exact: true })
        .click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
        'first',
      );
      await expect(
        first.getByRole('button', { name: 'Remove part', exact: true }),
      ).toBeDisabled();
      await first.getByLabel('Field name', { exact: true }).fill('');
      let publishRequests = 0;
      page.on('request', (outgoing) => {
        if (
          outgoing.method() === 'POST' &&
          new URL(outgoing.url()).pathname.endsWith('/publish')
        )
          publishRequests++;
      });
      await page
        .getByRole('button', { name: 'Publish v1', exact: true })
        .click();
      const publish = page.getByRole('dialog', {
        name: 'Publish v1',
        exact: true,
      });
      await publish
        .getByRole('button', { name: 'Publish v1', exact: true })
        .click();
      await expect(
        publish.getByText(
          'Finish or discard the unfinished edit in the step panel first.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(publishRequests).toBe(0);
      await publish
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await expect(
        first.getByText(
          'Use a field name up to 128 UTF-8 bytes without control characters.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        httpMultipartConfigSchema
          .parse(savedConfig(remote).multipart)
          .parts.every(({ name }) => name === 'title'),
      ).toBe(true);
      await first.getByLabel('Field name', { exact: true }).fill('restored');
      await expect
        .poll(() =>
          httpMultipartConfigSchema
            .parse(savedConfig(remote).multipart)
            .parts.map(({ name }) => name),
        )
        .toEqual(['restored']);
      await page
        .getByRole('button', { name: 'Add file part', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Upload part file', exact: true })
        .click();
      const upload = page.getByRole('dialog', {
        name: 'Upload a file',
        exact: true,
      });
      await expect(upload.getByText(/Up to 10 MB/u)).toBeVisible();
      await expect(
        upload.getByText(/A full 10 MB file will not fit/u),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`file-upload-${theme}-${String(width)}.png`),
        animations: 'disabled',
      });
      await upload.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
  }
