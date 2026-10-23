import { inputCaseFailure } from '../../../../src/problems/context/normalize.js';
import { problemResult } from '../../../support/problem.js';

import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants.js';

import {
  WorkflowInputCasesController,
  parseCaseIfMatch,
} from '../../../../src/workflow-authoring/input-cases/controller.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../../../../src/workflow-authoring/http/guards.js';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../../src/workspaces/index.js';

import {
  workspaceId,
  workflowId,
  caseId,
  versionId,
  actorId,
  sessionId,
  representationTag,
  result,
  fixture,
} from './fixture.js';

export function registerEnforcesExactStrongIfMatchGrammar(): void {
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
    const { cases } = fixture();
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
      problemResult(
        controller.update(
          { ...request, headers: { 'idempotency-key': 'case-once' } },
          { workspaceId, workflowId, caseId },
          { name: 'x', input: {} },
        ),
        inputCaseFailure,
      ),
    ).rejects.toMatchObject({ code: 'request.precondition_required' });
    await expect(
      problemResult(
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
        inputCaseFailure,
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      problemResult(
        controller.get(
          request,
          { workspaceId, workflowId, caseId: 'bad' },
          response,
        ),
        inputCaseFailure,
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });
}
