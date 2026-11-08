import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
  user,
} from '../workflow-editor/support';
const threadId = '11111111-1111-4111-8111-111111111111';
const commentId = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
for (const width of [375, 1280])
  test(`guards navigation and keeps an edit across reply polling at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({ nodes: [], edges: [], settings: {} }),
    );
    let count = 20;
    const edits: unknown[] = [];
    const thread = () => ({
      id: threadId,
      workflowId,
      stepId: null,
      stepLabel: null,
      status: 'open',
      revision: 1,
      createdBy: user.id,
      createdAt: '2026-10-18T10:00:00.000Z',
      updatedAt: '2026-10-18T10:00:00.000Z',
      commentCount: count,
      preview: 'Open this discussion',
    });
    const comment = (index: number) => ({
      id: commentId(index),
      threadId,
      authorId: user.id,
      authorName: 'Ada',
      body: `Comment ${String(index)}`,
      revision: 1,
      createdAt: new Date(
        Date.parse('2026-10-18T10:00:00Z') + index * 1000,
      ).toISOString(),
      editedAt: null,
      mentions: [],
    });
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/comments`;
    await page.route(`${root}?**`, (route) =>
      route.fulfill({ json: { items: [thread()], nextCursor: null } }),
    );
    await page.route(`${root}/${threadId}?**`, (route) =>
      route.fulfill({
        json: {
          thread: thread(),
          comments: Array.from({ length: 20 }, (_, index) =>
            comment(count - index),
          ),
          nextCursor: null,
        },
      }),
    );
    await page.route(`${root}/${threadId}/comments/*`, async (route) => {
      edits.push(route.request().postDataJSON() as unknown);
      await route.fulfill({
        json: {
          threadId,
          commentId: commentId(1),
          revision: 2,
          replayed: false,
          deleted: false,
          threadDeleted: false,
        },
      });
    });
    const url = `/w/${workspaceId}/workflows/${workflowId}/comments`;
    await page.goto(url);
    await page.getByRole('button', { name: 'New discussion' }).click();
    await page
      .getByRole('textbox', { name: 'New discussion' })
      .fill('Keep this discussion');
    await page.getByRole('button', { name: /Open this discussion/u }).click();
    const guard = page.getByRole('dialog', {
      name: 'Discard the unfinished discussion?',
    });
    await guard.getByRole('button', { name: 'Stay here' }).click();
    await expect(page).toHaveURL(url);
    await expect(
      page.getByRole('textbox', { name: 'New discussion' }),
    ).toHaveValue('Keep this discussion');
    await page.getByRole('button', { name: /Open this discussion/u }).click();
    await guard.getByRole('button', { name: 'Discard and leave' }).click();
    await expect(page).toHaveURL(`${url}?thread=${threadId}`);
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByText('Comment 1', { exact: true }) });
    await row
      .getByRole('button', { name: 'Edit comment', exact: true })
      .click();
    const input = page.getByRole('textbox', {
      name: 'Edit comment',
      exact: true,
    });
    await input.fill('Keep my oldest edit');
    count = 21;
    await expect(page.getByText('Comment 21', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(input).toHaveValue('Keep my oldest edit');
    await page.getByRole('button', { name: 'Save comment' }).click();
    await expect.poll(() => edits.length).toBe(1);
    expect(edits[0]).toEqual({
      body: 'Keep my oldest edit',
      mentionUserIds: [],
      expectedRevision: 1,
    });
  });
