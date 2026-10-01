import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants.js';
import { createWorkflowInputCaseTag } from '@pertexo/contracts/workflow-authoring';
import {
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
  WorkflowInputCaseUnavailableError,
  type WorkflowInputCaseDatabase,
} from '@pertexo/database/api';
import { WorkflowInputCasesUseCase } from '../../src/workflow-authoring/input-case-use-case.js';
import {
  WorkflowInputCasesController,
  parseCaseIfMatch,
} from '../../src/workflow-authoring/input-case-controller.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../../src/workflow-authoring/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../src/identity-workspace/index.js';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';
import {
  encodeInputCaseCursor,
  decodeInputCaseCursor,
} from '../../src/workflow-authoring/input-case-cursor.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const caseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'input-case-test',
});
const item = {
  id: caseId,
  workspaceId,
  workflowId,
  workflowVersionId: versionId,
  versionChecksum: `wf:v2:sha256:${'a'.repeat(64)}`,
  name: 'Synthetic',
  revision: 1,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
};
const context = { actor, routeWorkspaceId: workspaceId, workflowId };
const representationTag = createWorkflowInputCaseTag(caseId, 1);
const result = { caseId, revision: 2, replayed: true };
function fixture(
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer' = 'owner',
) {
  const persistence = {
    listCases: vi.fn().mockResolvedValue({
      items: [item],
      nextCursor: { createdAt: item.createdAt, id: caseId },
    }),
    getCase: vi
      .fn()
      .mockResolvedValue({ case: { ...item, input: { value: 1 } } }),
    createCase: vi.fn().mockResolvedValue(result),
    updateCase: vi.fn().mockResolvedValue(result),
    deleteCase: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies WorkflowInputCaseDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    persistence,
    authorization,
    cases: new WorkflowInputCasesUseCase(persistence, authorization),
  };
}
describe('workflow input case application interface', () => {
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
        cases.create({
          ...command,
          request: { ...command.request, workflowVersionId: versionId },
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      await expect(cases.update(command)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      await expect(cases.delete(command)).rejects.toMatchObject({
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
    await expect(cases.get({ ...context, caseId })).rejects.toMatchObject({
      code: 'resource.not_found',
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      cases.list({ ...context, query: {}, signal: abort.signal }),
    ).rejects.toThrow();
    expect(persistence.getCase).not.toHaveBeenCalled();
    expect(persistence.listCases).not.toHaveBeenCalled();
  });
  it('denies rebinding, oversized JSON and wrong-case or malformed validators before persistence', async () => {
    const { cases, persistence } = fixture();
    const command = {
      ...context,
      caseId,
      representationTag,
      idempotencyKey: 'case-once',
    };
    await expect(
      cases.update({
        ...command,
        request: { name: 'x', input: {}, workflowVersionId: versionId },
      }),
    ).rejects.toThrow();
    await expect(
      cases.create({
        ...command,
        request: {
          name: 'x',
          input: 'a'.repeat(65_536),
          workflowVersionId: versionId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      cases.delete({ ...command, representationTag: 'bad' }),
    ).rejects.toThrow();
    await expect(
      cases.delete({
        ...command,
        representationTag: createWorkflowInputCaseTag(versionId, 1),
      }),
    ).rejects.toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(persistence.createCase).not.toHaveBeenCalled();
    expect(persistence.updateCase).not.toHaveBeenCalled();
    expect(persistence.deleteCase).not.toHaveBeenCalled();
  });
  it('maps safe revision/quota/rollout failures without payload or name', () => {
    expect(
      mapWorkflowAuthoringError(new WorkflowInputCaseRevisionConflictError(2)),
    ).toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(
      mapWorkflowAuthoringError(
        new WorkflowInputCaseLimitError('retained_bytes'),
      ),
    ).toMatchObject({ code: 'workflow.input_case_limit_exceeded' });
    expect(
      mapWorkflowAuthoringError(new WorkflowInputCaseUnavailableError()),
    ).toMatchObject({ code: 'workflow.input_cases_unavailable' });
  });
});
describe('workflow input case HTTP interface', () => {
  it('enforces exact strong If-Match grammar', () => {
    expect(parseCaseIfMatch([representationTag])).toBe(representationTag);
    for (const value of [undefined, []])
      expect(() => parseCaseIfMatch(value)).toThrow(
        expect.objectContaining({ code: 'precondition_required' }),
      );
    for (const value of [
      '*',
      'W/' + representationTag,
      `${representationTag},${representationTag}`,
      [representationTag, representationTag],
      [1],
      null,
    ])
      expect(() => parseCaseIfMatch(value)).toThrow(
        expect.objectContaining({ code: 'invalid' }),
      );
  });
  it('declares session/read, update/CSRF, ordinary mutations and no-store on every route', () => {
    for (const name of ['list', 'get', 'create', 'update', 'delete'] as const) {
      // Metadata inspection does not invoke unbound controller methods.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const method = WorkflowInputCasesController.prototype[name];
      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual(
        name === 'list' || name === 'get'
          ? [SessionAuthenticationGuard, WorkflowReadGuard]
          : [
              SessionAuthenticationGuard,
              WorkflowUpdateGuard,
              CsrfProtectionGuard,
            ],
      );
      expect(Reflect.getMetadata(HEADERS_METADATA, method)).toContainEqual({
        name: 'Cache-Control',
        value: 'private, no-store',
      });
    }
  });
  it('passes commands and emits current GET ETag while rejecting malformed routes/headers', async () => {
    const { cases, persistence } = fixture();
    const controller = new WorkflowInputCasesController(cases);
    const request = {
      headers: {
        'idempotency-key': 'case-once',
        'if-match': representationTag,
      },
      identitySession: {
        userId: actorId,
        sessionId,
        expiresAt: new Date('2027-01-01'),
        clientMetadata: {},
      },
      requestId: 'input-case-test',
    };
    expect(
      await controller.list(request, { workspaceId, workflowId }, {}),
    ).toHaveProperty('items');
    const response = { header: vi.fn() };
    expect(
      await controller.get(
        request,
        { workspaceId, workflowId, caseId },
        response,
      ),
    ).toHaveProperty('case.input');
    expect(response.header).toHaveBeenCalledWith('ETag', representationTag);
    expect(
      await controller.create(
        request,
        { workspaceId, workflowId },
        { name: 'x', input: {}, workflowVersionId: versionId },
      ),
    ).toEqual(result);
    expect(
      await controller.update(
        request,
        { workspaceId, workflowId, caseId },
        { name: 'x', input: {} },
      ),
    ).toEqual(result);
    expect(
      await controller.delete(request, { workspaceId, workflowId, caseId }),
    ).toEqual(result);
    await expect(
      controller.update(
        { ...request, headers: { 'idempotency-key': 'case-once' } },
        { workspaceId, workflowId, caseId },
        { name: 'x', input: {} },
      ),
    ).rejects.toMatchObject({ code: 'request.precondition_required' });
    await expect(
      controller.delete(
        {
          ...request,
          headers: {
            'idempotency-key': 'bad,key',
            'if-match': representationTag,
          },
        },
        { workspaceId, workflowId, caseId },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      controller.get(
        request,
        { workspaceId, workflowId, caseId: 'bad' },
        response,
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    persistence.listCases.mockRejectedValue(
      new WorkflowInputCaseUnavailableError(),
    );
    await expect(
      controller.list(request, { workspaceId, workflowId }, {}),
    ).rejects.toMatchObject({ code: 'workflow.input_cases_unavailable' });
  });
});
