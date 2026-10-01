import {
  workflowInputCaseCommandResponseSchema,
  workflowInputCaseCreateRequestSchema,
  workflowInputCaseListResponseSchema,
  workflowInputCaseResponseSchema,
  workflowInputCaseUpdateRequestSchema,
  type WorkflowInputCaseCreateRequest,
  type WorkflowInputCaseUpdateRequest,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

function casesPath(workspaceId: string, workflowId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/input-cases`;
}

export function listInputCases(
  api: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal: AbortSignal,
  after?: string,
) {
  const query = new URLSearchParams({
    limit: '20',
    ...(after === undefined ? {} : { after }),
  });
  return api.request({
    path: `${casesPath(workspaceId, workflowId)}?${query}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowInputCaseListResponseSchema.parse(value),
    },
  });
}

export async function getInputCase(
  api: ApiClient,
  workspaceId: string,
  workflowId: string,
  caseId: string,
  signal: AbortSignal,
) {
  const response = await api.request({
    path: `${casesPath(workspaceId, workflowId)}/${encodeURIComponent(caseId)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value, metadata) => {
        const decoded = workflowInputCaseResponseSchema.parse(value);
        if (metadata.header('etag') !== decoded.case.representationTag)
          throw new Error(
            'Input-case body and strong representation tag differ.',
          );
        return decoded;
      },
    },
  });
  return response.case;
}

export type InputCaseCommand = Readonly<
  | { kind: 'create'; body: WorkflowInputCaseCreateRequest; key: string }
  | {
      kind: 'update';
      caseId: string;
      tag: string;
      body: WorkflowInputCaseUpdateRequest;
      key: string;
    }
  | { kind: 'delete'; caseId: string; tag: string; key: string }
>;

export function sendInputCaseCommand(
  api: ApiClient,
  workspaceId: string,
  workflowId: string,
  command: InputCaseCommand,
) {
  return api.request({
    path: `${casesPath(workspaceId, workflowId)}${command.kind === 'create' ? '' : `/${encodeURIComponent(command.caseId)}`}`,
    method:
      command.kind === 'create'
        ? 'POST'
        : command.kind === 'update'
          ? 'PUT'
          : 'DELETE',
    headers: {
      'Idempotency-Key': command.key,
      ...(command.kind === 'create' ? {} : { 'If-Match': command.tag }),
    },
    ...(command.kind === 'delete'
      ? {}
      : {
          body:
            command.kind === 'create'
              ? workflowInputCaseCreateRequestSchema.parse(command.body)
              : workflowInputCaseUpdateRequestSchema.parse(command.body),
        }),
    response: {
      kind: 'json',
      decode: (value) => workflowInputCaseCommandResponseSchema.parse(value),
    },
  });
}
