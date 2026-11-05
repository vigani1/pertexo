import {
  command as importCommand,
  database as importDatabase,
} from './portability/fixture.js';
import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkflowInputCaseStore } from '../../../src/authoring/input-cases/workflow-input-case.store.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/workflow-authoring.errors.js';
import {
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringStore,
  draftWrite,
  emptyGraph,
  holdAtWrite,
  saveCurrentDraft,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  builder,
  closeWorld,
  graphWith,
  hidden,
  hiddenFolderId,
  moveIntoFolder,
  open,
  openWorld,
  readOnly,
  viewer,
} from './access/world.js';

beforeAll(openWorld, 60_000);
afterAll(closeWorld);

describe('duplicating', () => {
  const duplicate = (actor: string, source: typeof open) =>
    authoring.duplicateWorkflow({
      workspaceId,
      actorId: actor,
      workflowId: source.id,
      name: 'A copy',
      source: { kind: 'version', versionId: source.versionId },
      idempotencyKey: randomUUID(),
    });

  it('needs only sight of the source, for a builder', async () => {
    const { workflowId } = await duplicate(builder, readOnly);
    expect(workflowId).not.toBe(readOnly.id);
    await expect(
      authoring.getWorkflow(workspaceId, workflowId, builder),
    ).resolves.toMatchObject({ id: workflowId, name: 'A copy' });
    // And what they can read they still can't change.
    await expect(
      authoring.renameWorkflow({
        workspaceId,
        actorId: builder,
        workflowId: readOnly.id,
        name: 'Refused',
        expectedNameRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('is not for a viewer, however well they can read the source', async () => {
    await expect(
      authoring.getWorkflow(workspaceId, open.id, viewer),
    ).resolves.toMatchObject({ id: open.id });
    await expect(duplicate(viewer, open)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it("isn't open from a folder the builder can't see", async () => {
    await expect(duplicate(builder, hidden)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
});

describe('a retry whose result has since moved out of the actor’s folders', () => {
  it('reads as missing when it creates', async () => {
    const input = {
      workspaceId,
      actorId: builder,
      name: 'Moves away',
      emptyGraph,
      idempotencyKey: randomUUID(),
    };
    const { workflowId } = await authoring.createWorkflow(input);
    await expect(authoring.createWorkflow(input)).resolves.toMatchObject({
      workflowId,
    });
    await moveIntoFolder(workflowId, hiddenFolderId);
    await expect(authoring.createWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it('reads as missing when an imported workflow moves out of sight', async () => {
    const database = importDatabase();
    try {
      const input = importCommand({ actorId: builder });
      const result = await database.importWorkflow(input);
      await expect(database.importWorkflow(input)).resolves.toEqual(result);
      await moveIntoFolder(result.workflowId, hiddenFolderId);
      await expect(database.importWorkflow(input)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    } finally {
      await database.close();
    }
  });

  it('reads as missing when it duplicates', async () => {
    const input = {
      workspaceId,
      actorId: builder,
      workflowId: open.id,
      name: 'Copy moves away',
      source: { kind: 'version' as const, versionId: open.versionId },
      idempotencyKey: randomUUID(),
    };
    const { workflowId } = await authoring.duplicateWorkflow(input);
    await expect(authoring.duplicateWorkflow(input)).resolves.toEqual({
      workflowId,
    });
    await moveIntoFolder(workflowId, hiddenFolderId);
    await expect(authoring.duplicateWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
});

describe('closing', () => {
  it('finishes what is in flight first, and refuses anything new', async () => {
    const { workflowId } = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Closing',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const held = await holdAtWrite(draftWrite(workflowId));
    const closing = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const order: string[] = [];
    try {
      const save = saveCurrentDraft(closing, {
        workspaceId,
        actorId,
        workflowId,
        expectedRevision: 1,
        graphJson: graphWith('saved'),
      }).then((saved) => {
        order.push('saved');
        return saved;
      });
      await held.reached();
      // Started before the close, and still waiting for the one connection.
      const queued = closing.getWorkflow(workspaceId, workflowId, actorId);
      const closed = closing.close().then(() => order.push('closed'));
      // The fixture hands the close on a tick later.
      await new Promise((tick) => setImmediate(tick));
      await expect(
        closing.getWorkflow(workspaceId, workflowId, actorId),
      ).rejects.toThrow('This authoring store is closed');
      expect(order).toEqual([]);
      await held.release();
      await expect(queued).resolves.toMatchObject({ id: workflowId });
      await closed;
      expect(order).toEqual(['saved', 'closed']);
      await expect(save).resolves.toMatchObject({ revision: 2 });
    } finally {
      await held.remove();
    }
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('refuses anything new on an input case store too', async () => {
    const cases = createWorkflowInputCaseStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    await expect(
      cases.listCases({
        workspaceId,
        actorId,
        workflowId: open.id,
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [] });
    await cases.close();
    await expect(
      cases.listCases({
        workspaceId,
        actorId,
        workflowId: open.id,
        limit: 1,
      }),
    ).rejects.toThrow('This authoring store is closed');
  });
});
