import { inputCaseFailure } from '../../../../src/problems/context/normalize.js';
import { problemResult } from '../../../support/problem.js';

import 'reflect-metadata';
import { expect, it } from 'vitest';

import {
  authorizeWorkspace,
  createActorContext,
} from '../../../../src/authorization/index.js';
import {
  encodeInputCaseCursor,
  decodeInputCaseCursor,
} from '../../../../src/workflow-authoring/input-cases/cursor.js';
import {
  workspaceId,
  workflowId,
  caseId,
  versionId,
  actorId,
  sessionId,
  item,
  context,
  representationTag,
  result,
  fixture,
} from './fixture.js';

export function registerSerializesDatesValidatorsPaginatesMetadataScopes(): void {
  it('serializes dates/validators, paginates metadata only and scopes opaque cursors', async () => {
    const { persistence, cases } = fixture('viewer');
    const page = await cases.list({ ...context, query: { limit: '5' } });
    expect(page.items[0]).toEqual({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      representationTag,
    });
    expect(page.items[0]).not.toHaveProperty('input');
    expect(page.nextCursor).toBeDefined();
    const nextCursor = page.nextCursor ?? '';
    await cases.list({ ...context, query: { after: nextCursor } });
    expect(persistence.listCases).toHaveBeenLastCalledWith({
      workspaceId,
      workflowId,
      actorId,
      limit: 20,
      cursor: { createdAt: item.createdAt, id: caseId },
    });
    expect((await cases.get({ ...context, caseId })).case.input).toEqual({
      value: 1,
    });
    persistence.listCases.mockResolvedValue({ items: [] });
    expect(await cases.list({ ...context, query: {} })).toEqual({ items: [] });
    expect(() =>
      decodeInputCaseCursor(nextCursor, { workspaceId, workflowId: caseId }),
    ).toThrow();
    for (const value of [
      'bad!',
      'e30',
      'Zh',
      nextCursor + '=',
      'x'.repeat(1025),
    ])
      expect(() =>
        decodeInputCaseCursor(value, { workspaceId, workflowId }),
      ).toThrow();
    expect(
      decodeInputCaseCursor(
        encodeInputCaseCursor(
          { workspaceId, workflowId },
          { createdAt: item.createdAt, id: caseId },
        ),
        { workspaceId, workflowId },
      ),
    ).toEqual({ createdAt: item.createdAt, id: caseId });
  });

  it('forwards the guarded authority snapshot and trace attribution without retaining payload', async () => {
    const { persistence, cases, authorization } = fixture();
    const tracedActor = createActorContext({
      actorId,
      workspaceId,
      sessionId,
      requestId: 'input-case-traced',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    const authorizedWorkspace = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access: authorization,
      disclosure: 'not_found',
    });
    await cases.create({
      ...context,
      actor: tracedActor,
      authorizedWorkspace,
      idempotencyKey: 'case-traced',
      request: { workflowVersionId: versionId, name: 'Synthetic', input: {} },
    });
    expect(persistence.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'input-case-traced',
        traceId: '0123456789abcdef0123456789abcdef',
      }),
    );
    expect(authorization.findAccess).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'admin', 'builder'] as const)(
    'allows %s writes with signal/attribution and identifier-only recovery',
    async (role) => {
      const { persistence, cases } = fixture(role);
      const signal = new AbortController().signal;
      const command = { ...context, signal, idempotencyKey: 'case-once' };
      expect(
        await cases.create({
          ...command,
          request: {
            workflowVersionId: versionId,
            name: ' Synthetic ',
            input: null,
          },
        }),
      ).toEqual(result);
      expect(persistence.createCase).toHaveBeenCalledWith({
        workspaceId,
        workflowId,
        actorId,
        signal,
        requestId: 'input-case-test',
        idempotencyKey: 'case-once',
        workflowVersionId: versionId,
        name: 'Synthetic',
        input: null,
      });
      expect(
        await cases.update({
          ...command,
          caseId,
          representationTag,
          request: { name: 'Edit', input: [] },
        }),
      ).toEqual(result);
      expect(persistence.updateCase).toHaveBeenCalledWith({
        workspaceId,
        workflowId,
        actorId,
        signal,
        requestId: 'input-case-test',
        idempotencyKey: 'case-once',
        caseId,
        expectedRevision: 1,
        name: 'Edit',
        input: [],
      });
      expect(
        await cases.delete({ ...command, caseId, representationTag }),
      ).toEqual(result);
      expect(persistence.deleteCase).toHaveBeenCalledWith({
        workspaceId,
        workflowId,
        actorId,
        signal,
        requestId: 'input-case-test',
        idempotencyKey: 'case-once',
        caseId,
        expectedRevision: 1,
      });
    },
  );

  it.each(['operator', 'viewer'] as const)(
    'allows %s load but denies every mutation independently of run:start',
    async (role) => {
      const { persistence, cases } = fixture(role);
      await cases.get({ ...context, caseId });
      const command = {
        ...context,
        caseId,
        representationTag,
        idempotencyKey: 'case-once',
        request: { name: 'Edit', input: {} },
      };
      await expect(
        problemResult(
          cases.create({
            ...command,
            request: { ...command.request, workflowVersionId: versionId },
          }),
          inputCaseFailure,
        ),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      await expect(
        problemResult(cases.update(command), inputCaseFailure),
      ).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      await expect(
        problemResult(cases.delete(command), inputCaseFailure),
      ).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(persistence.createCase).not.toHaveBeenCalled();
      expect(persistence.updateCase).not.toHaveBeenCalled();
      expect(persistence.deleteCase).not.toHaveBeenCalled();
    },
  );

  it('denies missing current authority and aborted operations before persistence', async () => {
    const { authorization, cases, persistence } = fixture();
    authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      problemResult(cases.get({ ...context, caseId }), inputCaseFailure),
    ).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      cases.list({ ...context, query: {}, signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persistence.getCase).not.toHaveBeenCalled();
    expect(persistence.listCases).not.toHaveBeenCalled();
  });
}
