import { COLLABORATION_LIMITS } from '@pertexo/contracts';
import { mappingGraph } from './workflow-editor/graph';
import {
  addCsrfCookie,
  definition,
  manualDefinition,
  user,
  editorUrl,
} from './workflow-editor/support';
import { expect, test } from './support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowSummary,
} from './workflow-editor/support';
import { workflowListBody } from './workflows/list-support';
for (const width of [375, 1280]) {
  test(`search reports waits and failures and hands off all matches at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/**', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'resource.not_found',
          requestId: 'shared-fixture-fallback',
        },
      }),
    );
    await installEditorRoutes(page, remoteDraft());
    let release: (() => void) | undefined;
    let first = true;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows?**`,
      async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('query') !== 'Needle')
          return route.fulfill({ json: workflowListBody(url.href, []) });
        if (first) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          first = false;
          return route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Search unavailable',
              status: 503,
              code: 'internal.unexpected',
              requestId: 'search-support-reference',
            },
          });
        }
        const next = url.searchParams.has('after');
        const rows = Array.from({ length: next ? 1 : 25 }, (_, index) => ({
          ...workflowSummary(`Needle ${String(next ? 26 : index + 1)}`)
            .workflow,
          id: `11111111-1111-4111-8111-${String(next ? 26 : index + 1).padStart(12, '0')}`,
        }));
        return route.fulfill({
          json: workflowListBody(url.href, rows, next ? null : 'page-two'),
        });
      },
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    await expect(
      page.getByRole('heading', { name: 'Workflows', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('combobox', {
      name: 'Search pages, workflows and actions',
    });
    await input.fill('Needle');
    await expect(page.getByText('Searching workflows…')).toBeVisible();
    await expect.poll(() => release !== undefined).toBe(true);
    release?.();
    await expect(
      page.getByText('Workflow search couldn’t be loaded. Try again.'),
    ).toBeVisible();
    await expect(page.getByText('Nothing matches “Needle”.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    const all = page.getByRole('option', {
      name: 'See all results for “Needle”',
    });
    await expect(all).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/query=Needle/);
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(
      page.getByText('Needle 26', { exact: true }).first(),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/workflows$`));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`search-recovery-${String(width)}.png`),
    });
  });
  test(`read recovery retains cooldown and support metadata before session recovery at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    await page.route('**/v1/**', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        json: {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'resource.not_found',
          requestId: 'shared-fixture-fallback',
        },
      }),
    );
    await installEditorRoutes(page, remoteDraft());
    let stage = 0;
    await page.route(`**/v1/workspaces/${workspaceId}/variables`, (route) => {
      if (stage === 3)
        return route.fulfill({
          json: { revision: 1, values: {}, descriptions: {} },
        });
      const status = [429, 500, 401][stage] ?? 401;
      const code = stage < 2 ? 'internal.unexpected' : 'auth.unauthenticated';
      return route.fulfill({
        status,
        contentType: 'application/problem+json',
        headers: { 'retry-after': '2' },
        json: {
          type: 'about:blank',
          title: 'Read refused',
          status,
          code,
          requestId: 'read-support-reference',
        },
      });
    });
    await page.goto(`/w/${workspaceId}/settings/variables`);
    const waiting = page.getByRole('button', { name: /Try again in/ });
    await expect(waiting).toBeDisabled();
    stage = 1;
    await page.clock.fastForward(2_100);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      page.getByText('read-support-reference', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`read-recovery-${String(width)}.png`),
    });
    stage = 2;
    await page.route('**/v1/auth/capabilities', (route) =>
      route.fulfill({
        json: {
          password: {
            enabled: true,
            minimumLength: 12,
            verificationRequired: true,
          },
          socialProviders: [],
          signUp: 'open',
        },
      }),
    );
    await page.route('**/v1/auth/sign-in/email', (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        email: 'operator@example.test',
        password: 'correct horse battery staple',
      });
      stage = 3;
      return route.fulfill({ json: { redirect: false, token: null, user } });
    });
    await page.route('**/v1/users/me', (route) =>
      stage === 3
        ? route.fulfill({ json: user })
        : route.fulfill({
            status: 401,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Session ended',
              status: 401,
              code: 'auth.unauthenticated',
              requestId: 'expired-session',
            },
          }),
    );
    await page.clock.fastForward(2_100);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    const url = new URL(page.url());
    expect(url.searchParams.get('returnTo')).toBe(
      `/w/${workspaceId}/settings/variables`,
    );
    await expect(
      page.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    await page.getByLabel('Email').fill('operator@example.test');
    await page
      .getByLabel('Password', { exact: true })
      .fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`/w/${workspaceId}/settings/variables`);
    await expect(
      page.getByText('No workspace variables configured.'),
    ).toBeVisible();
  });
}

for (const width of [375, 1280])
  test(`a component-owned expiry pauses editor scratch at ${String(width)}px`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const remote = remoteDraft(mappingGraph());
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    let authenticated = true;
    const refusal = {
      type: 'about:blank',
      title: 'Session ended',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'editor-component-expiry',
    };
    await page.route('**/v1/users/me', (route) =>
      authenticated
        ? route.fulfill({ json: user })
        : route.fulfill({
            status: 401,
            contentType: 'application/problem+json',
            json: refusal,
          }),
    );
    let expireComments = false;
    let commentsRead = false;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/*/comments?**`,
      (route) => {
        commentsRead = true;
        if (!expireComments)
          return route.fulfill({ json: { items: [], nextCursor: null } });
        authenticated = false;
        return route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          json: refusal,
        });
      },
    );
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width < 768)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByLabel('Count', { exact: true }).fill('12 private apples');
    await expect.poll(() => commentsRead).toBe(true);
    expireComments = true;
    await page.clock.fastForward(COLLABORATION_LIMITS.pollMs * 3 + 1);
    await expect(
      page.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    await expect(page).toHaveURL(editorUrl);
    await expect(
      page.getByRole('link', { name: /Sign in again/ }),
    ).toHaveAttribute('target', '_blank');
    await expect(
      page.getByText(
        'A different account signed in while this workflow was open.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(page.getByLabel('Count', { exact: true })).toBeHidden();
    authenticated = true;
    await page.getByRole('button', { name: 'Verify original account' }).click();
    await expect(page.getByLabel('Count', { exact: true })).toHaveValue(
      '12 private apples',
    );
    expect(remote.revision).toBe(1);
  });
