import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectProblem } from '../../../support/better-auth/real-api.support.js';

import type { createFoldersBulkFixture } from './fixture.js';

export function registerCommitsOrderedPartialBulkOutcomesBindsChanged(
  caseFixture: ReturnType<typeof createFoldersBulkFixture>,
): void {
  const { fixture, createFolder, api } = caseFixture;

  it('commits ordered partial bulk outcomes and binds changed/disjoint parents before any items', async () => {
    const f = await fixture(),
      foreign = await fixture(),
      destination = await createFolder(f);
    const key = randomUUID(),
      body = {
        operation: 'move',
        folderId: destination.id,
        items: [
          { workflowId: f.workflowId, expectedOrganizationRevision: 1 },
          { workflowId: foreign.workflowId, expectedOrganizationRevision: 1 },
        ],
      };
    const send = (payload: object, idempotencyKey = key) =>
      api.send('POST', `${f.route}/workflows/organization/bulk`, {
        browser: f.browser,
        headers: { 'idempotency-key': idempotencyKey },
        payload,
      });
    const first = await send(body);
    expect(first.statusCode, first.payload).toBe(200);
    expect(first.json()).toEqual({
      items: [
        {
          workflowId: f.workflowId,
          status: 'updated',
          organizationRevision: 2,
          replayed: false,
        },
        { workflowId: foreign.workflowId, status: 'not_visible' },
      ],
    });
    expect((await send(body)).json()).toMatchObject({
      items: [{ replayed: true }, { status: 'not_visible' }],
    });
    for (const changed of [
      { ...body, items: [...body.items].reverse() },
      {
        ...body,
        items: [{ workflowId: randomUUID(), expectedOrganizationRevision: 1 }],
      },
      { operation: 'replace_tags', tagIds: [], items: body.items },
    ])
      expectProblem(await send(changed), 409, 'request.idempotency_conflict');
    const stale = await send({ ...body, items: [body.items[0]] }, randomUUID());
    expect(stale.json()).toEqual({
      items: [
        {
          workflowId: f.workflowId,
          status: 'conflict',
          code: 'workflow.organization_revision_conflict',
        },
      ],
    });
    const inaccessibleFolder = await send(
      {
        ...body,
        folderId: randomUUID(),
        items: [{ workflowId: f.workflowId, expectedOrganizationRevision: 2 }],
      },
      randomUUID(),
    );
    expect(inaccessibleFolder.json()).toEqual({
      items: [
        {
          workflowId: f.workflowId,
          status: 'conflict',
          code: 'workflow.folder_not_visible',
        },
      ],
    });
  });

  it('shares cleanup parent identity with general bulk and preserves archived placement', async () => {
    const f = await fixture(),
      destination = await createFolder(f);
    const tagResponse = await api.send('POST', `${f.route}/workflow-tags`, {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { key: 'cleanup' },
    });
    expect(tagResponse.statusCode, tagResponse.payload).toBe(201);
    const tagId = tagResponse.json<{ tag: { id: string } }>().tag.id;
    const initialPlacement = await api.send(
      'POST',
      `${f.route}/workflows/${f.workflowId}/folder`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          folderId: destination.id,
          expectedOrganizationRevision: 1,
        },
      },
    );
    expect(initialPlacement.statusCode, initialPlacement.payload).toBe(200);
    const replacement = await api.send(
      'POST',
      `${f.route}/workflows/organization/bulk`,
      {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          operation: 'replace_tags',
          tagIds: [tagId],
          items: [
            { workflowId: f.workflowId, expectedOrganizationRevision: 2 },
          ],
        },
      },
    );
    expect(replacement.statusCode, replacement.payload).toBe(200);
    expect(
      (
        await api.send('POST', `${f.route}/workflows/${f.workflowId}/archive`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedLifecycleRevision: 1 },
        })
      ).statusCode,
    ).toBe(202);
    const key = randomUUID(),
      payload = {
        tagId,
        items: [{ workflowId: f.workflowId, expectedOrganizationRevision: 3 }],
      };
    const cleanup = () =>
      api.send('POST', `${f.route}/workflow-tags/cleanup/detach`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload,
      });
    const detached = await cleanup();
    expect(detached.statusCode, detached.payload).toBe(200);
    expect(detached.json()).toEqual({
      items: [
        {
          workflowId: f.workflowId,
          status: 'detached',
          organizationRevision: 4,
          replayed: false,
        },
      ],
    });
    expect((await cleanup()).json()).toMatchObject({
      items: [{ replayed: true }],
    });
    expectProblem(
      await api.send('POST', `${f.route}/workflows/organization/bulk`, {
        browser: f.browser,
        headers: { 'idempotency-key': key },
        payload: { operation: 'move', folderId: null, items: payload.items },
      }),
      409,
      'request.idempotency_conflict',
    );
    const metadata = await api.send(
      'GET',
      `${f.route}/workflows/${f.workflowId}?include=organization`,
      { browser: f.browser },
    );
    expect(metadata.json()).toMatchObject({
      organization: {
        folderId: destination.id,
        tags: [],
        organizationRevision: 4,
      },
    });
  });
}
