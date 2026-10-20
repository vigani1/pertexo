import { expect, test, type Page } from '../../support/fixtures';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspace,
  type RemoteDraft,
} from '../support';

function draft() {
  return remoteDraft({
    nodes: [
      {
        id: 'action',
        label: 'Prepare data',
        definition: { key: 'core.set', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: { value: 'preserved' },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
  });
}
async function open(page: Page, width: number) {
  await page.getByTestId('rf__node-action').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
  await page.locator('summary').filter({ hasText: 'Retries ·' }).click();
}
function saved(remote: RemoteDraft) {
  return parseWorkflowGraphDraft(remote.graph).nodes[0];
}

for (const width of [375, 1280]) {
  test(`sets total tries and fixed waits without hiding unfinished values at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = draft();
    await installEditorRoutes(page, remote);
    await page.goto(editorUrl);
    await open(page, width);
    const policy = page.getByLabel('Retry policy', { exact: true });
    const choose = async (name: string) => {
      await policy.click();
      await page.getByRole('option', { name, exact: true }).click();
    };
    await expect(policy).toContainText('Platform default');
    await expect(policy).not.toHaveAccessibleDescription(
      /Finish incomplete fields/u,
    );
    await choose('Custom');
    const tries = page.getByLabel('Max tries', { exact: true });
    const wait = page.getByLabel('Wait between tries (in seconds)', {
      exact: true,
    });
    await expect(tries).toHaveValue('3');
    await expect(wait).toHaveValue('1');
    await tries.fill('6');
    await tries.press('Tab');
    await expect(tries).toHaveAttribute('aria-invalid', 'true');
    await expect(policy).toBeDisabled();
    await expect(policy).toHaveAccessibleDescription(
      /Finish incomplete fields/u,
    );
    await tries.fill('5');
    await wait.fill('1.5');
    await wait.press('Tab');
    await expect(wait).toHaveAttribute('aria-invalid', 'true');
    await expect(policy).toBeDisabled();
    await wait.fill('2');
    await expect(policy).toBeEnabled();
    await expect(policy).not.toHaveAccessibleDescription(
      /Finish incomplete fields/u,
    );
    await expect
      .poll(() => saved(remote)?.retry)
      .toEqual({ maximumAttempts: 5, delayMillis: 2_000 });
    await choose('Do not retry');
    await expect.poll(() => saved(remote)?.retry?.maximumAttempts).toBe(1);
    await page
      .getByText(/Unknown outcomes are never retried automatically/u)
      .click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(() => saved(remote)?.retry)
      .toEqual({ maximumAttempts: 5, delayMillis: 2_000 });
    await page.reload();
    await open(page, width);
    await expect(page.getByLabel('Max tries', { exact: true })).toHaveValue(
      '5',
    );
    await choose('Platform default');
    await expect
      .poll(() => Object.hasOwn(saved(remote) ?? {}, 'retry'))
      .toBe(false);
    expect(saved(remote)?.config).toEqual({ value: 'preserved' });
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await expect(
      page
        .getByRole('tabpanel', { name: 'About', exact: true })
        .getByText(
          'Up to three total tries for eligible failures, with increasing waits and jitter.',
          { exact: true },
        ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`shows a read-only retry policy at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = draft();
    const node = saved(remote);
    if (node === undefined) throw new Error('The action must exist');
    remote.graph = {
      ...remote.graph,
      nodes: [{ ...node, retry: { maximumAttempts: 4, delayMillis: 3_000 } }],
    };
    await installEditorRoutes(page, remote, {
      accessibleWorkspace: {
        ...workspace,
        role: 'viewer',
        capabilities: [
          'workspace:read',
          'workflow:read',
          'run:read',
          'connection:read',
        ],
      },
    });
    await page.goto(editorUrl);
    await open(page, width);
    await expect(
      page.getByLabel('Retry policy', { exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Max tries', { exact: true })).toHaveValue(
      '4',
    );
    await expect(page.getByLabel('Max tries', { exact: true })).toBeDisabled();
    await expect(
      page.getByLabel('Wait between tries (in seconds)', { exact: true }),
    ).toBeDisabled();
    await page.getByRole('tab', { name: 'About', exact: true }).click();
    await expect(
      page
        .getByRole('tabpanel', { name: 'About', exact: true })
        .getByText(
          'Up to 4 total tries for eligible failures, waiting 3 seconds between tries.',
          { exact: true },
        ),
    ).toBeVisible();
    expect(remote.revision).toBe(1);
  });
}
