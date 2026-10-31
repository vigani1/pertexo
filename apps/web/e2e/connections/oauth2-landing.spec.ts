import { connectionId, workspaceId } from './fixture';

import { expect, test } from '../support/fixtures';

// A missing screen is a failure at once, not a timeout, which test.fail wouldn't accept.
test.use({ actionTimeout: 5_000 });

const landing = (query: string) => `/connections/oauth2/finished?${query}`;
const named = `workspaceId=${workspaceId}&connectionId=${connectionId}`;

// Landing page table: each result's text, exactly as written.
for (const [result, text] of [
  ['connected', 'Connected. You can close this tab.'],
  ['denied', "You didn't allow access. Nothing changed."],
  [
    'token_refused',
    "The service refused the sign-in. Check the client ID, secret and token URL. If they're right, try sending them in the request body.",
  ],
  [
    'provider_unavailable',
    "The service didn't answer. Try again in a few minutes.",
  ],
] as const)
  test.fail(
    `landing: ${result} says so and links to the connection`,
    async ({ page }) => {
      await page.goto(landing(`result=${result}&${named}`));
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: /connection/iu }),
      ).toHaveAttribute(
        'href',
        new RegExp(`/w/${workspaceId}/connections.*${connectionId}`, 'u'),
      );
    },
  );

// Landing page table, S7: invalid names no connection, so nothing to link to.
test.fail(
  'landing: invalid says so, with no connection link',
  async ({ page }) => {
    await page.goto(landing('result=invalid'));
    await expect(
      page.getByText(
        'This sign-in link is no longer valid. Start again from Connections.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /connection/iu })).toHaveCount(
      0,
    );
  },
);

// Landing page: public, reads no data. A signed-out browser, and no API call at all.
test.fail('landing: is public and reads no data', async ({ page }) => {
  const called: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/v1/'))
      called.push(request.url());
  });
  await page.goto(landing(`result=connected&${named}`));
  await expect(
    page.getByText('Connected. You can close this tab.', { exact: true }),
  ).toBeVisible();
  expect(called).toEqual([]);
});

// Landing page: anything else in the address is the invalid page.
test.fail('landing: an unknown result reads as invalid', async ({ page }) => {
  await page.goto(landing('result=hacked'));
  await expect(
    page.getByText(
      'This sign-in link is no longer valid. Start again from Connections.',
      { exact: true },
    ),
  ).toBeVisible();
});

// Landing page: posts to the channel and tries to close itself.
test.fail('landing: tells the channel and tries to close', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { seen: unknown[] }).seen = seen;
    new BroadcastChannel('pertexo.connections.oauth2').onmessage = (event) => {
      seen.push(event.data);
    };
    window.close = () => {
      seen.push('closed');
    };
  });
  await page.goto(landing(`result=connected&${named}`));
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { seen: unknown[] }).seen),
    )
    .toContain('closed');
  const seen = await page.evaluate(
    () => (window as unknown as { seen: unknown[] }).seen,
  );
  expect(seen.length).toBeGreaterThan(1);
});
