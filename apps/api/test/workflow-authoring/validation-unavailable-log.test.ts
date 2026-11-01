import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
import { describe, expect, it, vi } from 'vitest';

import { APPLICATION_ERROR_MAPPERS } from '../../src/application-errors.js';
import { RequestContextStore } from '../../src/platform/http/request-context.js';
import { ProblemDetailsFilter } from '../../src/platform/http/problem-details.filter.js';
import { authoringFailure } from '../../src/problems/context/normalize.js';
import {
  hostFor,
  responseMock,
} from '../platform/http/problem-details.filter/fixture.js';

/** Through the real filter, so these see what the log and the caller really get. */
function render(error: unknown) {
  const log = vi.fn();
  const filter = new ProblemDetailsFilter(
    new RequestContextStore(),
    { log },
    APPLICATION_ERROR_MAPPERS,
  );
  const response = responseMock();
  filter.catch(error, hostFor({ url: '/v1/workflows/a/publish' }, response));
  const logged = log.mock.calls[0]?.[0] as Readonly<{
    code: string;
    cause: unknown;
  }>;
  return { logged, response };
}

const flatten = (value: unknown): string =>
  value instanceof Error
    ? `${value.name} ${value.message} ${JSON.stringify(value)} ${flatten(value.cause)}`
    : (JSON.stringify(value) ?? '');

describe('publish validation that could not run', () => {
  it.each([
    'closed',
    'database_budget',
    'report_limit',
    'not_configured',
  ] as const)(
    'logs the reason %s and tells the caller only to retry',
    (reason) => {
      const { logged, response } = render(
        authoringFailure(new AuthoringValidationUnavailableError(reason)),
      );

      expect(logged.code).toBe('workflow.validation_unavailable');
      expect(logged.cause).toMatchObject({ reason });
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.header).toHaveBeenCalledWith('retry-after', '1');
      expect(response.body).toMatchObject({
        code: 'workflow.validation_unavailable',
      });
      expect(JSON.stringify(response.body)).not.toContain(reason);
    },
  );

  it.each(['message', 'path', 'nodeId', 'code'])(
    'keeps what a person wrote in %s out of both the log and the response',
    (field) => {
      const written = 'SECRET-WRITTEN-BY-A-PERSON'.repeat(60);
      const { logged, response } = render(
        authoringFailure(
          new InvalidWorkflowGraphError([
            {
              code: 'workflow.invalid',
              path: '$.nodes.action',
              message: 'Cannot parse.',
              [field]: written,
            },
          ] as never),
        ),
      );

      expect(logged.code).toBe('workflow.validation_unavailable');
      expect(flatten(logged)).not.toContain('SECRET-WRITTEN');
      expect(JSON.stringify(response.body)).not.toContain('SECRET-WRITTEN');
    },
  );
});
