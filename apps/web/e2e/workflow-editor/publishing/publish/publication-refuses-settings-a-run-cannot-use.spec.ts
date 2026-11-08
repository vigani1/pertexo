import { expect, test } from '../../../support/fixtures';

import { addStep } from '../../actions';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../../support';

import { installPublishRoutes } from './fixture';

// What the real API answers for an HTTP step's timeout past its limit.
const refusal = 'timeoutMillis: Too big: expected number to be <=120000';

test('a publish refused for settings a run cannot use says why, publishes nothing and keeps the draft', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const remote = remoteDraft();
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await installPublishRoutes(page, remote);
  let attempts = 0;
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
    (route) => {
      attempts += 1;
      return route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        json: {
          type: 'urn:pertexo:problem:workflow.invalid',
          title: 'Invalid workflow',
          status: 422,
          code: 'workflow.invalid',
          requestId: 'settings-publish',
          errors: [
            {
              path: '$.nodes.target.config.timeoutMillis',
              code: 'invalid_graph',
              message: refusal,
            },
          ],
        },
      });
    },
  );
  await page.goto(editorUrl);
  await addStep(page, /Set fields/u).click();
  await expect.poll(() => remote.revision).toBe(2);
  const savedGraph = structuredClone(remote.graph);

  await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish v1', exact: true });
  await dialog.getByRole('button', { name: 'Publish v1', exact: true }).click();

  await expect(
    dialog
      .getByRole('region', { name: 'Blocking issues' })
      .getByText(refusal, { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(1);
  expect(remote.graph).toEqual(savedGraph);
  await expect(page.getByText(/^v1 is /u)).toHaveCount(0);
});
