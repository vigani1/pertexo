import { expect, test, type Page } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from './workflow-editor-support';

const misfirePolicy = {
  default: 'catch_up_once',
  type: 'string',
  enum: ['catch_up_once', 'skip'],
};
const scheduleDefinition = {
  ...definition,
  definition: { key: 'core.schedule', version: 3 },
  family: 'trigger',
  configVersion: 3,
  configSchema: {
    oneOf: [
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'cron' },
          expression: { type: 'string', minLength: 9, maxLength: 255 },
          timezone: { type: 'string', minLength: 1, maxLength: 255 },
          misfirePolicy,
        },
        required: ['kind', 'expression', 'timezone', 'misfirePolicy'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'interval' },
          intervalMinutes: { type: 'integer', minimum: 1, maximum: 43_200 },
          misfirePolicy,
        },
        required: ['kind', 'intervalMinutes', 'misfirePolicy'],
        additionalProperties: false,
      },
    ],
  },
  inputSchema: {},
  ports: { inputs: [], outputs: ['out'] },
};

async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('builds a schedule with a sentence preview and saves the step’s own config', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        id: 'nightly',
        label: 'Nightly',
        definition: { key: 'core.schedule', version: 3 },
        position: { x: 80, y: 80 },
        configVersion: 3,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [scheduleDefinition],
  });
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-nightly').click();
  await expect(page.getByText('Not scheduled yet')).toBeVisible();

  await choose(page, 'Runs', 'Weekly on chosen days');
  // Monday is picked to start with.
  await page.getByRole('button', { name: 'Thursday' }).click();
  await page.getByLabel('At', { exact: true }).fill('18:30');
  await choose(page, 'Timezone', 'America/New York');
  const preview = page.getByRole('region', { name: 'When it runs' });
  await expect(preview).toContainText('Every Monday and Thursday at 6:30 PM');
  await expect(preview).toContainText('America/New York time');
  await expect(preview).toContainText('When the clocks change');
  await expect
    .poll(() => remote.graph.nodes[0], { timeout: 4_000 })
    .toMatchObject({
      config: {
        kind: 'cron',
        expression: '30 18 * * 1,4',
        timezone: 'America/New_York',
        misfirePolicy: 'catch_up_once',
      },
    });

  await choose(page, 'Runs', 'Custom cron rule');
  const rule = page.getByLabel('Cron rule', { exact: true });
  await expect(rule).toHaveValue('30 18 * * 1,4');
  await rule.fill('30 18 * *');
  // The error waits until the field is left, so typing never shifts it.
  await rule.blur();
  await expect(page.getByText(/A cron rule has five parts/u)).toBeVisible();
  await expect(
    page.getByText('An edit isn’t valid yet, so it isn’t saved.'),
  ).toBeVisible();
  await rule.fill('0 */4 * * *');
  await expect(preview).toContainText('Every 4 hours at :00');
  await expect
    .poll(() => remote.graph.nodes[0], { timeout: 4_000 })
    .toMatchObject({ config: { expression: '0 */4 * * *' } });
});
