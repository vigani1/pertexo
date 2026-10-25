import { expect, test } from '../../support/fixtures';
import { slackConnection } from '../../../test/support/fixtures/slack-channels';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
} from '../support';

const connectionId = '44444444-4444-4444-8444-444444444444';
const slackDefinition = {
  ...definition,
  definition: { key: 'slack.send_message', version: 1 },
  connectionRequirements: ['slack_bot_token'],
};

for (const width of [390, 1280]) {
  for (const status of [
    'missing',
    'revoked',
    'reauthorization_required',
  ] as const) {
    test(`shows and fixes ${status} credentials at ${String(width)} pixels`, async ({
      page,
      context,
    }) => {
      await addCsrfCookie(context);
      await page.setViewportSize({ width, height: 768 });
      const remote = remoteDraft({
        nodes: [
          {
            id: 'post',
            label: 'Tell ops',
            definition: slackDefinition.definition,
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs:
              status === 'missing' ? {} : { slack_bot_token: connectionId },
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      await installEditorRoutes(page, remote, {
        definitions: [slackDefinition],
      });
      let current = {
        ...slackConnection(workspaceId, connectionId),
        status: status === 'missing' ? 'active' : status,
      };
      await page.route(
        `**/v1/workspaces/${workspaceId}/connections?**`,
        (route) =>
          route.fulfill({ json: { items: [current], nextCursor: null } }),
      );
      await page.goto(editorUrl);
      const chip = page.getByRole('button', { name: '2 issues' });
      await expect(chip).toBeVisible();
      await chip.click();
      const fix = page.getByRole('button', {
        name: /Fix:.*(?:Slack|Ops bot)/u,
      });
      await expect(fix).toContainText('Fix');
      await fix.click();
      const picker = page.getByLabel('Slack connection');
      await expect(picker).toBeVisible();
      if (status === 'missing') {
        await picker.click();
        await page.getByRole('option', { name: 'Ops bot' }).click();
        await expect(chip).toHaveCount(0);
      } else {
        current = { ...current, status: 'active' };
        await page.reload();
      }
      await expect(page.getByRole('button', { name: '1 issue' })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (status === 'missing')
        await page.screenshot({
          path: `/tmp/pertexo-polish-4-${String(width)}.png`,
        });
    });
  }
}

test('explains disabled server connections without claiming the owner’s role changed', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft({
    nodes: [
      {
        id: 'post',
        definition: slackDefinition.definition,
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: { slack_bot_token: connectionId },
        position: { x: 80, y: 80 },
      },
    ],
    edges: [],
    settings: {},
  });
  await installEditorRoutes(page, remote, { definitions: [slackDefinition] });
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      status: 404,
      json: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Not Found',
      },
    }),
  );
  await page.goto(editorUrl);
  await page.getByRole('button', { name: '2 issues' }).click();
  await expect(page.getByRole('region', { name: '2 issues' })).toContainText(
    'Connections are unavailable here',
  );
});
