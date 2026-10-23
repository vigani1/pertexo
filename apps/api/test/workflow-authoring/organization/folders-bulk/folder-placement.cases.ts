import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectProblem } from '../../../support/better-auth/real-api.support.js';

import type { createFoldersBulkFixture } from './fixture.js';

export function registerServesRealFolderCRUDSharedPlacementRevisions(
  caseFixture: ReturnType<typeof createFoldersBulkFixture>,
): void {
  const { fixture, createFolder, api } = caseFixture;

  it('serves real folder CRUD, shared placement revisions, exact filters and nonempty conflicts', async () => {
    const f = await fixture(),
      destination = await createFolder(f, ' Ops ');
    expect(destination).toMatchObject({ name: 'Ops', revision: 1, depth: 1 });
    expectProblem(
      await api.send('POST', `${f.route}/workflow-folders`, {
        headers: {
          cookie: f.browser.cookie,
          'idempotency-key': randomUUID(),
        },
        payload: { name: 'Missing CSRF', parentId: null },
      }),
      403,
      'auth.forbidden',
    );
    expectProblem(
      await api.send('POST', `${f.route}/workflow-folders`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Private input',
          parentId: null,
          actorId: randomUUID(),
        },
      }),
      400,
      'request.invalid',
    );
    const child = await createFolder(f, 'Child', destination.id);
    const placement = { folderId: child.id, expectedOrganizationRevision: 1 };
    const key = randomUUID();
    const sendPlacement = () =>
      api.send('POST', `${f.route}/workflows/${f.workflowId}/folder`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload: placement,
      });
    const placed = await sendPlacement();
    expect(placed.statusCode, placed.payload).toBe(200);
    expect(placed.json()).toEqual({
      workflowId: f.workflowId,
      folderId: child.id,
      organizationRevision: 2,
      replayed: false,
    });
    expect((await sendPlacement()).json()).toMatchObject({ replayed: true });
    for (const [folderId, expected] of [
      [destination.id, 0],
      [child.id, 1],
      ['root', 0],
    ] as const) {
      const page = await api.send(
        'GET',
        `${f.route}/workflows?folderId=${folderId}&include=organization`,
        { browser: f.browser },
      );
      expect(page.statusCode, page.payload).toBe(200);
      expect(page.json<{ items: unknown[] }>().items).toHaveLength(expected);
    }
    const rename = await api.send(
      'POST',
      `${f.route}/workflow-folders/${child.id}/rename`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'New child', expectedFolderRevision: 1 },
      },
    );
    expect(rename.statusCode, rename.payload).toBe(200);
    expect(rename.json()).toMatchObject({ folder: { revision: 2 } });
    const review = await api.send(
      'POST',
      `${f.route}/workflow-folders/review-move`,
      {
        browser: f.browser,
        payload: {
          kind: 'folder',
          folderId: child.id,
          destinationFolderId: null,
        },
      },
    );
    expect(review.statusCode, review.payload).toBe(200);
    expect(review.json()).toMatchObject({
      items: [{ id: child.id, requiresReview: false }],
    });
    const moved = await api.send(
      'POST',
      `${f.route}/workflow-folders/${child.id}/move`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { parentId: null, expectedFolderRevision: 2 },
      },
    );
    expect(moved.statusCode, moved.payload).toBe(200);
    expect(moved.json()).toMatchObject({
      folder: { parentId: null, revision: 3, depth: 1 },
    });
    expectProblem(
      await api.send('POST', `${f.route}/workflow-folders/${child.id}/delete`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedFolderRevision: 3 },
      }),
      409,
      'workflow.folder_not_empty',
    );
    const unfile = await api.send(
      'POST',
      `${f.route}/workflows/${f.workflowId}/folder`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { folderId: null, expectedOrganizationRevision: 2 },
      },
    );
    expect(unfile.statusCode, unfile.payload).toBe(200);
    expect(
      (
        await api.send(
          'POST',
          `${f.route}/workflow-folders/${child.id}/delete`,
          {
            browser: f.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { expectedFolderRevision: 3 },
          },
        )
      ).statusCode,
    ).toBe(200);
    const folders = await api.send('GET', `${f.route}/workflow-folders`, {
      browser: f.browser,
    });
    expect(folders.headers['cache-control']).toBe('private, no-store');
    expect(folders.json<{ items: unknown[] }>().items).toHaveLength(1);
  });
}
