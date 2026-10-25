import {
  formConfigSchema,
  type EventCoordinationPolicy,
} from '@pertexo/workflow-model';
import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import { createWorkflowNodeFixture } from '../../../test/support/fixtures/graph';
import { readEditorDraft } from '../../support/authoring/single-step';
export async function save(
  page: Page,
  path: string,
  trigger: 'core.webhook' | 'core.form',
) {
  const first = createWorkflowNodeFixture({
    id: 'entry',
    definition: { key: trigger, version: 1 },
    position: { x: 0, y: 0 },
  });
  const finish = createWorkflowNodeFixture({
    id: 'finish',
    definition: { key: 'core.terminate', version: 1 },
    position: { x: 280, y: 0 },
  });
  const graph = {
    settings: {},
    nodes: [
      {
        ...first,
        config:
          trigger === 'core.form'
            ? formConfigSchema.parse({
                title: 'Order request',
                fields: [
                  {
                    id: 'order',
                    name: 'orderId',
                    label: 'Order',
                    type: 'text',
                  },
                  {
                    id: 'message',
                    name: 'message',
                    label: 'Message',
                    type: 'text',
                  },
                ],
              })
            : { responseMode: 'workflow', responseWaitSeconds: 1 },
      },
      finish,
    ],
    edges: [
      {
        id: 'finish',
        source: { nodeId: 'entry', port: 'out' },
        target: { nodeId: 'finish', port: 'in' },
      },
    ],
  };
  const draft = await page.request.get(`${path}/draft`);
  const result = await page.request.put(`${path}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph },
  });
  expect(result.status()).toBe(200);
  await page.reload();
  await page.getByTestId('rf__node-entry').focus();
  await page.keyboard.press('Enter');
}

export async function configure(
  page: Page,
  path: string,
  mode: EventCoordinationPolicy['mode'],
  isForm = false,
) {
  await page.getByLabel('Policy', { exact: true }).click();
  await page
    .getByRole('option', {
      name: {
        deduplicate: 'Deduplicate',
        debounce: 'Debounce',
        throttle: 'Throttle',
      }[mode],
      exact: true,
    })
    .click();
  await page
    .getByLabel('Run input path', { exact: true })
    .fill(isForm ? '$.values.orderId' : '$.orderId');
  await page.keyboard.press('Tab');
  if (mode === 'debounce')
    await page.getByLabel('Quiet time (seconds)', { exact: true }).fill('2');
  if (mode === 'throttle') {
    await page.getByLabel('Window (seconds)', { exact: true }).fill('5');
    await page.getByLabel('Extra events', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Delay in arrival order', exact: true })
      .click();
    const limit = page.getByLabel('Runs per window', { exact: true });
    await limit.fill('');
    await page.keyboard.press('Tab');
    await expect(
      page.getByText('Use a whole number from 1 to 1000.', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await readEditorDraft(page, path)).graph.nodes[0]?.config
            .coordination,
      )
      .toMatchObject({ limit: 1 });
    await limit.fill('1');
    await page.keyboard.press('Tab');
    await expect(
      page.getByText('Use a whole number from 1 to 1000.', { exact: true }),
    ).toHaveCount(0);
  }
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.config.coordination,
    )
    .toMatchObject({ mode });
}

export async function send({
  origin,
  endpoint,
  secret,
  key,
  payload,
}: Readonly<{
  origin: string;
  endpoint: string;
  secret: string;
  key: string;
  payload: unknown;
}>) {
  const body = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(timestamp + '.' + body)
    .digest('hex')}`;
  try {
    const response = await fetch(new URL(`/hooks/${endpoint}`, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pertexo-timestamp': timestamp,
        'x-pertexo-signature': signature,
        'idempotency-key': key,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `Owned webhook returned HTTP ${String(response.status)}.`,
      );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } catch {
    throw new Error('Owned coordination request failed; credentials omitted');
  }
}
