import type { ArgumentsHost } from '@nestjs/common';
import {
  workflowPauseConflictProblemSchema,
  workflowConcurrencyRevisionConflictProblemSchema,
  workflowConcurrencyLimitExceededProblemSchema,
  workflowAutoPauseSettingsConflictProblemSchema,
  workspaceAutoPauseSettingsConflictProblemSchema,
} from '@pertexo/contracts';
import { vi } from 'vitest';

interface ResponseMock {
  body?: unknown;
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

export function responseMock(): ResponseMock {
  const response: ResponseMock = {
    body: undefined,
    status: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };

  response.status.mockReturnValue(response);
  response.send.mockImplementation((body: unknown) => {
    response.body = body;
  });
  return response;
}

export function hostFor(
  request: Readonly<{
    url?: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
    raw?: Readonly<{ destroyed?: boolean }>;
  }>,
  response: ResponseMock | object,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

export const revisionConflicts = [
  {
    code: 'workflow.lifecycle_conflict',
    field: 'currentLifecycleRevision',
    command: 'archive',
  },
  {
    code: 'workflow.name_conflict',
    field: 'currentNameRevision',
    command: 'rename',
  },
] as const;

export const autoPauseConflicts = [
  {
    code: 'workflow.concurrency_revision_conflict',
    field: 'currentRevision',
    value: 7,
    schema: workflowConcurrencyRevisionConflictProblemSchema,
    invalid: [undefined, 0, -1, 1.5, '2', 2_147_483_648],
  },
  {
    code: 'workflow.concurrency_limit_exceeded',
    field: 'maximum',
    value: 4,
    schema: workflowConcurrencyLimitExceededProblemSchema,
    invalid: [undefined, 0, -1, 1.5, '2', 10_001],
  },
  {
    code: 'workflow.pause_conflict',
    field: 'currentPauseRevision',
    value: '9223372036854775807',
    schema: workflowPauseConflictProblemSchema,
    invalid: [undefined, 1, '0', '01', '-1', '1.5', '9223372036854775808'],
  },
  {
    code: 'workflow.auto_pause_settings_conflict',
    field: 'currentSettingsRevision',
    value: 7,
    schema: workflowAutoPauseSettingsConflictProblemSchema,
    invalid: [undefined, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1],
  },
  {
    code: 'workspace.auto_pause_settings_conflict',
    field: 'currentRevision',
    value: 7,
    schema: workspaceAutoPauseSettingsConflictProblemSchema,
    invalid: [undefined, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1],
  },
] as const;
