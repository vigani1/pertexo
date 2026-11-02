import { createHmac, randomUUID } from 'node:crypto';
import { expect as baseExpect, type Page } from '@playwright/test';
import {
  workflowRunResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts';
import { readEditorDraft } from '../../support/authoring/single-step';

/** Several real services sit behind each assertion; a busy machine mustn't fail one. */
export const expect = baseExpect.configure({ timeout: 30_000 });

/** Adds a step from the palette and opens it, the way a person does. */
export async function addStep(
  page: Page,
  path: string,
  kind: RegExp,
  label: string,
) {
  const before = (await readEditorDraft(page, path)).graph.nodes;
  await page
    .getByRole('complementary', { name: 'Add a step' })
    .getByRole('button', { name: kind })
    .click();
  await expect
    .poll(async () => (await readEditorDraft(page, path)).graph.nodes.length)
    .toBe(before.length + 1);
  const node = (await readEditorDraft(page, path)).graph.nodes.find(
    (candidate) => !before.some(({ id }) => id === candidate.id),
  );
  if (node === undefined) throw new Error('Authored step missing');
  await page.getByTestId(`rf__node-${node.id}`).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.keyboard.press('Tab');
  return node.id;
}

/** Deletes a step with the keyboard, once the canvas has drawn it. */
export async function removeStep(page: Page, path: string, nodeId: string) {
  const node = page.getByTestId(`rf__node-${nodeId}`);
  await expect(node).toBeVisible();
  await node.click();
  await node.focus();
  await page.keyboard.press('Backspace');
  await expect(node).toBeHidden();
  await expect
    .poll(async () =>
      (await readEditorDraft(page, path)).graph.nodes.map(({ id }) => id),
    )
    .not.toContain(nodeId);
}

/** Sets a literal input on the open step and waits for it to be saved. */
export async function setLiteralInput(
  page: Page,
  path: string,
  input: Readonly<{ nodeId: string; field: string; value: unknown }>,
) {
  const { nodeId, field, value } = input;
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill(field);
  await row
    .getByLabel('JSON value', { exact: true })
    .fill(JSON.stringify(value));
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes.find(
          ({ id }) => id === nodeId,
        )?.inputMappings[field],
    )
    .toEqual({ kind: 'literal', value });
}

/**
 * Publishes the next version through the dialog and returns the dialog's text. A
 * webhook with no address yet isn't live: nothing can start it, and the notice says so.
 */
export async function publishNext(
  page: Page,
  version: number,
  outcome: 'live' | 'needs-webhook-address' = 'live',
) {
  const name = `Publish v${String(version)}`;
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name, exact: true })).toBeEnabled();
  const shown = await dialog.innerText();
  await dialog.getByRole('button', { name, exact: true }).click();
  // A saturated validator refuses and offers a retry; a person presses it.
  const published = outcome === 'live' ? 'live' : 'published';
  const live = page.getByText(`v${String(version)} is ${published}`, {
    exact: true,
  });
  const again = dialog.getByRole('button', { name: 'Try again', exact: true });
  for (let tries = 0; tries < 5; tries += 1) {
    await expect(live.or(again).first()).toBeVisible();
    if (await live.isVisible()) break;
    await again.click();
  }
  await expect(live).toBeVisible();
  if (outcome === 'needs-webhook-address')
    await expect(
      page.getByText('One step left: create the webhook address.', {
        exact: true,
      }),
    ).toBeVisible();
  return shown;
}

export async function onlyVersion(page: Page, path: string) {
  const response = await page.request.get(`${path}/versions`);
  expect(response.status()).toBe(200);
  const { items } = workflowVersionsResponseSchema.parse(await response.json());
  expect(items).toHaveLength(1);
  const version = items[0];
  if (version === undefined) throw new Error('Published version is missing');
  return version;
}

/** waitForRun with this file's patience: a failing step retries with backoff first. */
export async function runReaches(
  page: Page,
  workspaceId: string,
  runId: string,
  status: string,
) {
  const path = `/v1/workspaces/${workspaceId}/runs/${runId}`;
  async function read() {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    return workflowRunResponseSchema.parse(await response.json());
  }
  await expect
    .poll(async () => (await read()).run.status, { timeout: 60_000 })
    .toBe(status);
  return read();
}

/** A sender outside the browser: real HMAC over exact bytes. */
export async function sendSigned(
  url: string,
  secret: string,
  key: string = randomUUID(),
) {
  const body = '{}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature,
        'idempotency-key': key,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Owned webhook sender failed; sensitive details omitted.');
  }
}
