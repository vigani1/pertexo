import {
  workflowListResponseSchema,
  workflowSummaryResponseSchema,
  workflowDraftResponseSchema,
  workflowVersionsResponseSchema,
  workflowPublishResponseSchema,
  strongEtagSchema,
  workflowExportRequestSchema,
  workflowImportPreviewRequestSchema,
  workflowImportPreviewResponseSchema,
  workflowImportRequestSchema,
  workflowImportResponseSchema,
  workflowRunStartRequestSchema,
  workflowRunStartResponseSchema,
  workflowRunListResponseSchema,
  workflowRunResponseSchema,
  workflowRunCancelRequestSchema,
  workflowRunCancelResponseSchema,
} from '@pertexo/contracts';
import { workflowPortableManifestSchema } from '@pertexo/workflow-model';
import type { z } from 'zod';
import type { AutomationArguments } from './arguments.js';
import type { AutomationHttpClient, AutomationHttpResponse } from './http.js';
import { readCommandJson } from './files.js';
import { AutomationCommandError, invalidArgument } from './errors.js';

function requestValue<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? parsed.data
    : invalidArgument(
        'The options or JSON body do not match this command’s API contract.',
      );
}
function responseValue<Value>(
  schema: z.ZodType<Value>,
  input: unknown,
  { uncertain = false }: Readonly<{ uncertain?: boolean | undefined }> = {},
): Value {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AutomationCommandError(
      'cli.invalid_response',
      'The server response does not match its API contract.',
      undefined,
      { uncertain: uncertain },
    );
  return parsed.data;
}
function query(
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  ).toString();
}
export async function executeAutomationCommand(
  client: AutomationHttpClient,
  command: AutomationArguments,
  signal: AbortSignal,
): Promise<unknown> {
  const base = `/v1/workspaces/${command.workspaceId}` as const;
  const workflow = (workflowId: string) =>
    `${base}/workflows/${workflowId}` as const;
  const run = (runId: string) => `${base}/runs/${runId}` as const;
  const body =
    !('bodyFile' in command) || command.bodyFile === undefined
      ? {}
      : await readCommandJson(command.bodyFile);
  const headers = {
    ...(!('key' in command) ? {} : { 'Idempotency-Key': command.key }),
    ...(!('etag' in command) || command.etag === undefined
      ? {}
      : { 'If-Match': command.etag }),
  };
  const get = (path: `/v1/${string}`) =>
    client.request({ path, signal, effect: 'read' });
  const post = (
    path: `/v1/${string}`,
    effect: 'read' | 'write',
    value?: unknown,
  ) =>
    client.request({
      path,
      method: 'POST',
      effect,
      headers,
      signal,
      ...(value === undefined ? {} : { body: value }),
    });
  let response: AutomationHttpResponse;
  switch (command.operation) {
    case 'workflows list':
      response = await get(`${base}/workflows?${query(command.query)}`);
      return responseValue(workflowListResponseSchema, response.body);
    case 'workflows get':
      return responseValue(
        workflowSummaryResponseSchema,
        (await get(workflow(command.workflowId))).body,
      );
    case 'workflows draft': {
      response = await get(`${workflow(command.workflowId)}/draft`);
      return {
        ...responseValue(workflowDraftResponseSchema, response.body),
        etag: responseValue(strongEtagSchema, response.etag),
      };
    }
    case 'workflows versions':
      response = await get(
        `${workflow(command.workflowId)}/versions?${query(command.query)}`,
      );
      return responseValue(workflowVersionsResponseSchema, response.body);
    case 'workflows export': {
      const request = requestValue(workflowExportRequestSchema, body);
      if (request.source.kind === 'draft' && command.etag === undefined)
        return invalidArgument('Draft export requires its reviewed --etag.');
      if (request.source.kind === 'version' && command.etag !== undefined)
        return invalidArgument(
          'Version export does not accept a draft --etag.',
        );
      return responseValue(
        workflowPortableManifestSchema,
        (await post(`${workflow(command.workflowId)}/export`, 'read', request))
          .body,
      );
    }
    case 'workflows import-preview':
      return responseValue(
        workflowImportPreviewResponseSchema,
        (
          await post(
            `${base}/workflows/import/preview`,
            'read',
            requestValue(workflowImportPreviewRequestSchema, body),
          )
        ).body,
      );
    case 'workflows import':
      return responseValue(
        workflowImportResponseSchema,
        (
          await post(
            `${base}/workflows/import`,
            'write',
            requestValue(workflowImportRequestSchema, body),
          )
        ).body,
        { uncertain: true },
      );
    case 'workflows publish':
      return responseValue(
        workflowPublishResponseSchema,
        (await post(`${workflow(command.workflowId)}/publish`, 'write')).body,
        { uncertain: true },
      );
    case 'runs start':
      return responseValue(
        workflowRunStartResponseSchema,
        (
          await post(
            `${workflow(command.workflowId)}/runs`,
            'write',
            requestValue(workflowRunStartRequestSchema, body),
          )
        ).body,
        { uncertain: true },
      );
    case 'runs list':
      response = await get(`${base}/runs?${query(command.query)}`);
      return responseValue(workflowRunListResponseSchema, response.body);
    case 'runs get':
      return responseValue(
        workflowRunResponseSchema,
        (await get(run(command.runId))).body,
      );
    case 'runs cancel':
      return responseValue(
        workflowRunCancelResponseSchema,
        (
          await post(
            `${run(command.runId)}/cancel`,
            'write',
            requestValue(workflowRunCancelRequestSchema, body),
          )
        ).body,
        { uncertain: true },
      );
  }
}
