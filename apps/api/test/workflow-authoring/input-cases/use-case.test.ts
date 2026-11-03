import { describe, expect, it } from 'vitest';
import {
  inputCaseFailure,
  authoringFailure,
} from '../../../src/problems/context/normalize.js';
import { problemResult } from '../../support/problem.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../../src/authorization/index.js';
import {
  encodeInputCaseCursor,
  decodeInputCaseCursor,
} from '../../../src/workflow-authoring/input-cases/cursor.js';
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
} from './use-case/fixture.js';
import { toProblem } from '../../../src/problems/registry.js';
import { WorkflowInputCasesUseCase } from '../../../src/workflow-authoring/input-cases/workflow-input-cases.service.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';
import { createWorkflowInputCaseTag } from '@pertexo/contracts';
import {
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
} from '@pertexo/core/authoring';
import {
  WorkflowInputCasesController,
  parseCaseIfMatch,
} from '../../../src/workflow-authoring/input-cases/controller.js';

describe('workflow input case application interface', () => {
  it('serializes dates/validators, paginates metadata only and scopes opaque cursors', async () => {
    const { persistence, cases } = fixture('viewer');
    const page = await cases.list({ ...context, query: { limit: 5 } });
    expect(page.items[0]).toEqual({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      representationTag,
    });
    expect(page.items[0]).not.toHaveProperty('input');
    expect(page.nextCursor).toBeDefined();
    const nextCursor = page.nextCursor ?? '';
    await cases.list({ ...context, query: { limit: 20, after: nextCursor } });
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
    expect(await cases.list({ ...context, query: { limit: 20 } })).toEqual({
      items: [],
    });
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
            name: 'Synthetic',
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
      cases.list({ ...context, query: { limit: 20 }, signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persistence.getCase).not.toHaveBeenCalled();
    expect(persistence.listCases).not.toHaveBeenCalled();
  });

  it('denies wrong-case or malformed validators before persistence', async () => {
    const { cases, persistence } = fixture();
    const command = {
      ...context,
      caseId,
      representationTag,
      idempotencyKey: 'case-once',
    };
    await expect(
      cases.delete({ ...command, representationTag: 'bad' }),
    ).rejects.toMatchObject({ name: 'WorkflowHeaderError', code: 'invalid' });
    await expect(
      problemResult(
        cases.delete({
          ...command,
          representationTag: createWorkflowInputCaseTag(versionId, 1),
        }),
        inputCaseFailure,
      ),
    ).rejects.toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(persistence.createCase).not.toHaveBeenCalled();
    expect(persistence.updateCase).not.toHaveBeenCalled();
    expect(persistence.deleteCase).not.toHaveBeenCalled();
  });

  it('maps safe revision/quota/rollout failures without payload or name', () => {
    expect(
      toProblem(
        authoringFailure(new WorkflowInputCaseRevisionConflictError(2)),
      ),
    ).toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(
      toProblem(
        authoringFailure(new WorkflowInputCaseLimitError('retained_bytes')),
      ),
    ).toMatchObject({ code: 'workflow.input_case_limit_exceeded' });
  });
});
// Nest dynamic modules require a class token.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class InputCaseRoutesUnderTest {}

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

  it('answers commands, sends the current ETag and refuses bad input over HTTP', async () => {
    const { cases, persistence } = fixture();
    const harness = await routeHarness({
      module: InputCaseRoutesUnderTest,
      imports: [{ module: FakeIdentityModule }],
      controllers: [WorkflowInputCasesController],
      providers: [
        { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
        { provide: WorkflowInputCasesUseCase, useValue: cases },
      ],
    });
    try {
      const root = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/input-cases`;
      const one = `${root}/${caseId}`;
      const headers = {
        'idempotency-key': 'case-once',
        'if-match': representationTag,
      };
      expect((await harness.send('GET', root)).json()).toHaveProperty('items');
      const read = await harness.send('GET', one);
      expect(read.json()).toHaveProperty('case.input');
      expect(read.headers.etag).toBe(representationTag);
      expect(read.headers['cache-control']).toBe('private, no-store');
      const created = await harness.send('POST', root, {
        body: { name: ' x ', input: {}, workflowVersionId: versionId },
        headers,
      });
      expect(created.statusCode, created.payload).toBe(201);
      expect(persistence.createCase).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'x' }),
      );
      const updated = await harness.send('PUT', one, {
        body: { name: 'x', input: {} },
        headers,
      });
      expect(updated.json()).toEqual(result);
      expect((await harness.send('DELETE', one, { headers })).json()).toEqual(
        result,
      );
      const refusals = [
        // Rebinding the version, and input past the size bound.
        harness.send('PUT', one, {
          body: { name: 'x', input: {}, workflowVersionId: versionId },
          headers,
        }),
        harness.send('POST', root, {
          body: {
            name: 'x',
            input: 'a'.repeat(65_536),
            workflowVersionId: versionId,
          },
          headers,
        }),
        harness.send('DELETE', one, {
          headers: {
            'idempotency-key': 'bad,key',
            'if-match': representationTag,
          },
        }),
        harness.send('GET', `${root}/bad`),
      ];
      for (const reply of await Promise.all(refusals)) {
        expect(reply.statusCode).toBe(400);
        expect(reply.json()).toMatchObject({ code: 'request.invalid' });
      }
      const unconditional = await harness.send('PUT', one, {
        body: { name: 'x', input: {} },
        headers: { 'idempotency-key': 'case-once' },
      });
      expect(unconditional.statusCode).toBe(428);
      expect(unconditional.json()).toMatchObject({
        code: 'request.precondition_required',
      });
      expect(persistence.createCase).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });
});
