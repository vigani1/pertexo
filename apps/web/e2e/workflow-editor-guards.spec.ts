import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  definition,
  editorNode,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  mappingGraph,
  remoteDraft,
  user,
} from './workflow-editor-support';

test('applies schema controls live and keeps invalid numbers as guarded scratch', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        id: 'node-a',
        definition: { key: 'core.set', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: { count: 7, legacy: { preserved: true } },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);
  await page.locator('.react-flow__node').click();
  await page.getByLabel('Value', { exact: true }).fill('reviewed');
  await page.getByLabel('Label', { exact: true }).fill('Configured set');
  const count = page.getByLabel('Count', { exact: true });
  await expect(count).toHaveValue('7');
  await count.fill('');
  await expect
    .poll(() => remote.graph.nodes[0], { timeout: 4_000 })
    .toMatchObject({
      label: 'Configured set',
      config: { value: 'reviewed', legacy: { preserved: true } },
    });
  expect(remote.graph.nodes[0]).not.toHaveProperty('config.count');

  const savedRevision = remote.revision;
  await count.fill('-');
  // The error waits until the field is left, so typing never shifts it.
  await count.blur();
  await expect(page.getByText('Count must be a number.')).toBeVisible();
  await expect(
    page.getByText('An edit isn’t valid yet, so it isn’t saved.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to workflows' }).click();
  await expect(
    page.getByRole('heading', { name: 'Leave with an unfinished edit?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(page).toHaveURL(editorUrl);
  expect(remote.revision).toBe(savedRevision);

  await count.fill('-2.5');
  await expect(page.getByText('Count must be a number.')).toBeHidden();
  await expect
    .poll(() => remote.graph.nodes[0], { timeout: 4_000 })
    .toMatchObject({ config: { count: -2.5, legacy: { preserved: true } } });
  await page.getByRole('button', { name: 'Increase Count' }).click();
  await expect(count).toHaveValue('-1.5');
});

test('resolves unfinished edits on step switches and keeps history consistent', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      editorNode('node-a', 'Node A', 'A', 80),
      editorNode('node-b', 'Node B', 'B', 380),
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);

  await page.getByTestId('rf__node-node-a').click();
  await page.getByLabel('Count', { exact: true }).fill('not a number');
  await page.getByTestId('rf__node-node-b').click();
  await expect(
    page.getByRole('heading', { name: 'Discard the unfinished edit?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Count', { exact: true })).toHaveValue(
    'not a number',
  );

  await page.getByTestId('rf__node-node-b').click();
  await page.getByRole('button', { name: 'Discard edit' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Node B');
  expect(remote.revision).toBe(1);

  await page.getByLabel('Label', { exact: true }).fill('Applied B');
  await page.getByTestId('rf__node-node-a').click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Node A');
  await expect.poll(() => remote.revision, { timeout: 4_000 }).toBe(2);

  await page.getByTestId('rf__node-node-b').click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Applied B',
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Node B');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Applied B',
  );

  await page.getByLabel('Count', { exact: true }).fill('still not a number');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('heading', { name: 'Discard the unfinished edit?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Count', { exact: true })).toHaveValue(
    'still not a number',
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Discard edit' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Node B');
});

test('scopes keyboard deletion to the canvas and offers Undo', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [editorNode('node-a', 'Node A', 'A', 80)],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-node-a').click();
  await page.getByLabel('Count', { exact: true }).fill('unfinished');

  await page.getByRole('button', { name: 'Keyboard shortcuts' }).focus();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('rf__node-node-a')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Discard the unfinished edit?' }),
  ).toBeHidden();

  await page.getByTestId('rf__node-node-a').click();
  await page.keyboard.press('Delete');
  await expect(
    page.getByRole('heading', { name: 'Discard the unfinished edit?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByLabel('Count', { exact: true })).toHaveValue(
    'unfinished',
  );

  await page.getByTestId('rf__node-node-a').click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Discard edit' }).click();
  await expect(page.getByTestId('rf__node-node-a')).toBeHidden();
  await expect(page.getByText('Deleted “Node A”')).toBeVisible();
  // The notification's Undo comes after the command bar's in the page.
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByTestId('rf__node-node-a')).toBeVisible();
});

test('cross-tab sign-out pauses a dirty editor without exposing its scratch to the new session', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  const second = await context.newPage();
  let authenticated = true;
  await addCsrfCookie(context);
  for (const tab of [page, second]) {
    await installEditorRoutes(tab, remote, {
      definitions: [manualDefinition, definition],
    });
    await tab.route('**/v1/users/me', async (route) => {
      if (authenticated) await route.fulfill({ json: user });
      else
        await route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'urn:pertexo:problem:auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'cross-tab-auth-loss',
          }),
        });
    });
  }
  await second.route('**/v1/auth/logout', async (route) => {
    authenticated = false;
    await route.fulfill({ status: 204 });
  });

  await page.goto(editorUrl);
  await page.getByTestId('rf__node-target').click();
  // Not a number, so it stays in the field as unfinished scratch.
  await page.getByLabel('Count', { exact: true }).fill('12 private apples');
  await second.goto('/workspaces');
  await second.getByRole('button', { name: /^Account menu for/u }).click();
  await second.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Editor paused' }),
  ).toBeVisible();
  await expect(page.getByLabel('Count', { exact: true })).toBeHidden();
  expect(remote.revision).toBe(1);
  authenticated = true;
  await page.getByRole('button', { name: 'Verify original account' }).click();
  await expect(page.getByLabel('Count', { exact: true })).toHaveValue(
    '12 private apples',
  );
  await second.close();
});
