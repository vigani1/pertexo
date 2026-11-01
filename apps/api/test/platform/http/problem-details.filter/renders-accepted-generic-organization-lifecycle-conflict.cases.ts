import { toProblem } from '../../../../src/problems/registry.js';

import { apiProblemSchema } from '@pertexo/contracts';
import { expect, it } from 'vitest';

import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
  isApplicationError,
} from '../../../../src/platform/http/index.js';

import { APPLICATION_ERROR_MAPPERS } from '../../../../src/application-errors.js';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
import { WorkflowTagConflictError } from '@pertexo/core/authoring';
import {
  responseMock,
  hostFor,
  revisionConflicts,
  autoPauseConflicts,
} from './fixture.js';

export function registerRendersAcceptedGenericOrganizationLifecycleConflict(): void {
  it('renders the accepted generic organization lifecycle conflict without fabricating a lifecycle revision', () => {
    const mapped = toProblem(new WorkflowTagConflictError('lifecycle'));
    expect(mapped.code).toBe('workflow.lifecycle_conflict');
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      mapped,
      hostFor(
        { url: '/v1/workspaces/workspace-a/workflows/workflow-a/folder' },
        response,
      ),
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.body).toMatchObject({
      code: 'workflow.lifecycle_conflict',
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).not.toHaveProperty('currentLifecycleRevision');
    expect(response.body).not.toHaveProperty('details');
  });

  it('retains lifecycle revision validation even with an organization discriminator', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('workflow.lifecycle_conflict', {
        details: {
          conflictProjection: 'organization',
          currentLifecycleRevision: 0,
        },
      }),
      hostFor({}, response),
    );
    expect(response.status).toHaveBeenCalledWith(500);
  });

  it('renders authoring admission failures as safe 503 with Retry-After, never raw causes or graph input', () => {
    const contexts = new RequestContextStore();
    const filter = new ProblemDetailsFilter(
      contexts,
      undefined,
      APPLICATION_ERROR_MAPPERS,
    );
    const response = responseMock();
    contexts.run('request-authoring', () => {
      filter.catch(
        new AuthoringValidationUnavailableError('report_limit'),
        hostFor(
          { url: '/v1/workspaces/workspace-a/workflows/workflow-a/validate' },
          response,
        ),
      );
    });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.header).toHaveBeenCalledWith('retry-after', '1');
    expect(response.body).toMatchObject({
      code: 'workflow.validation_unavailable',
      status: 503,
    });
    expect(apiProblemSchema.safeParse(response.body).success).toBe(true);
    expect(response.body).not.toHaveProperty('cause');
    expect(response.body).not.toHaveProperty('errors');
  });

  it.each([null, undefined, false, 0, 'request.invalid'])(
    'does not classify primitive value %j as an application error',
    (value) => {
      expect(isApplicationError(value)).toBe(false);
    },
  );

  it.each(revisionConflicts)(
    'exposes only the current revision for $code without a draft ETag or untrusted details',
    ({ code, field, command }) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError(code, {
          details: { [field]: 7, secret: 'not-public' },
        }),
        hostFor(
          { url: `/v1/workspaces/workspace/workflows/workflow/${command}` },
          response,
        ),
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.body).toEqual(
        expect.objectContaining({ code, [field]: 7 }),
      );
      expect(response.body).not.toHaveProperty('secret');
      expect(response.body).not.toHaveProperty('currentEtag');
      for (const other of revisionConflicts)
        if (other.field !== field)
          expect(response.body).not.toHaveProperty(other.field);
      expect(response.header).not.toHaveBeenCalledWith(
        'etag',
        expect.anything(),
      );
    },
  );

  it.each(
    revisionConflicts.flatMap((conflict) =>
      [undefined, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1].map(
        (revision) => ({ ...conflict, revision }),
      ),
    ),
  )(
    'fails closed for an invalid $code revision $revision',
    ({ code, field, revision }) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError(code, { details: { [field]: revision } }),
        hostFor({}, response),
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.body).toMatchObject({ code: 'internal.unexpected' });
      expect(response.body).not.toHaveProperty(field);
    },
  );

  it.each(autoPauseConflicts)(
    'projects a strict $code problem, preserving only its current revision',
    ({ code, field, value, schema }) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError(code, {
          details: {
            currentPauseRevision: '2',
            currentSettingsRevision: 3,
            currentRevision: 4,
            currentEtag: 'draft',
            secret: 'not-public',
            [field]: value,
          },
        }),
        hostFor({ url: '/v1/workspaces/workspace/auto-pause' }, response),
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(schema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({ code, [field]: value });
      expect(response.body).not.toHaveProperty('secret');
      expect(response.body).not.toHaveProperty('currentEtag');
      for (const other of autoPauseConflicts)
        if (other.field !== field)
          expect(response.body).not.toHaveProperty(other.field);
      expect(response.header).not.toHaveBeenCalledWith(
        'etag',
        expect.anything(),
      );
    },
  );

  it.each(
    autoPauseConflicts.flatMap(({ code, field, invalid }) =>
      invalid.map((value) => ({ code, field, value })),
    ),
  )(
    'fails closed on malformed $code revision $value',
    ({ code, field, value }) => {
      const response = responseMock();
      new ProblemDetailsFilter(new RequestContextStore()).catch(
        applicationError(code, {
          details: { [field]: value, secret: 'not-public' },
        }),
        hostFor({}, response),
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.body).toMatchObject({ code: 'internal.unexpected' });
      expect(response.body).not.toHaveProperty(field);
      expect(response.body).not.toHaveProperty('secret');
      expect(response.header).not.toHaveBeenCalledWith(
        'etag',
        expect.anything(),
      );
    },
  );

  it('rejects oversized safe details before they can reach the response boundary', () => {
    expect(() =>
      applicationError('request.invalid', { safeDetail: 'x'.repeat(2_001) }),
    ).toThrow(/too long/u);
  });

  it('drops blank safe detail instead of emitting an empty detail field', () => {
    const response = responseMock();
    new ProblemDetailsFilter(new RequestContextStore()).catch(
      applicationError('request.invalid', { safeDetail: '\r\n  ' }),
      hostFor({ url: '/v1/resource' }, response),
    );

    expect(response.body).not.toHaveProperty('detail');
  });
}
