import {
  strongEtagSchema,
  workflowExportRequestSchema,
  workflowImportPreviewRequestSchema,
  workflowImportRequestSchema,
  workflowRunCancelRequestSchema,
  workflowRunStartRequestSchema,
} from '@pertexo/contracts';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { AutomationArguments } from './automation-arguments.js';
import type {
  AutomationHttpClient,
  AutomationHttpResponse,
} from './automation-http-client.js';
import { readCommandJson } from './command-json-file.js';
import {
  AutomationCommandError,
  invalidArgument,
} from './automation-command.errors.js';

function requestValue<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? parsed.data
    : invalidArgument(
        'The options or JSON body do not match this command’s API contract.',
      );
}
/**
 * The CLI prints what the server sent. A newer server may add fields and statuses,
 * and an older CLI mustn't call that invalid, so it only checks the shape it prints.
 */
function responseValue(
  input: AutomationHttpResponse,
  { uncertain = false }: Readonly<{ uncertain?: boolean | undefined }> = {},
): object {
  if (typeof input.body === 'object' && input.body !== null) return input.body;
  throw new AutomationCommandError(
    'cli.invalid_response',
    'The server response is not a JSON object.',
    undefined,
    { uncertain },
  );
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
  const headers = commandHeaders(command);
  const get = (path: `/v1/${string}`, requestSignal = signal) =>
    client.request({ path, signal: requestSignal, effect: 'read' });
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
  switch (command.operation) {
    case 'whoami':
      return responseValue(await get('/v1/token'));
    case 'workflows list':
      return responseValue(
        await get(
          `${base}/workflows?${query({ ...command.query, include: 'listSummary' })}`,
        ),
      );
    case 'workflows get':
      return responseValue(await get(workflow(command.workflowId)));
    case 'workflows draft':
      return draftWithEtag(
        await get(`${workflow(command.workflowId)}/draft?include=graphDigest`),
      );
    case 'workflows versions':
      return responseValue(
        await get(
          `${workflow(command.workflowId)}/versions?${query({ ...command.query, include: 'graphDigest' })}`,
        ),
      );
    case 'workflows export':
      return responseValue(
        await post(
          `${workflow(command.workflowId)}/export`,
          'read',
          exportRequest(body, command.etag),
        ),
      );
    case 'workflows import-preview':
      return responseValue(
        await post(
          `${base}/workflows/import/preview`,
          'read',
          requestValue(workflowImportPreviewRequestSchema, body),
        ),
      );
    case 'workflows import':
      return responseValue(
        await post(
          `${base}/workflows/import`,
          'write',
          requestValue(workflowImportRequestSchema, body),
        ),
        { uncertain: true },
      );
    case 'workflows publish':
      return responseValue(
        await post(`${workflow(command.workflowId)}/publish`, 'write'),
        { uncertain: true },
      );
    case 'runs start':
      return responseValue(
        await post(
          `${workflow(command.workflowId)}/runs`,
          'write',
          requestValue(workflowRunStartRequestSchema, body),
        ),
        { uncertain: true },
      );
    case 'runs list':
      return responseValue(await get(`${base}/runs?${query(command.query)}`));
    case 'runs get':
      return responseValue(await get(run(command.runId)));
    case 'runs wait':
      return waitForRun(
        (waitSignal) => get(run(command.runId), waitSignal),
        command.timeoutSeconds,
        signal,
      );
    case 'runs cancel':
      return responseValue(
        await post(
          `${run(command.runId)}/cancel`,
          'write',
          requestValue(workflowRunCancelRequestSchema, body),
        ),
        { uncertain: true },
      );
  }
}

function draftWithEtag(response: AutomationHttpResponse): object {
  const etag = strongEtagSchema.safeParse(response.etag);
  if (!etag.success)
    throw new AutomationCommandError(
      'cli.invalid_response',
      'The server did not return the draft’s ETag.',
    );
  return { ...responseValue(response), etag: etag.data };
}

function exportRequest(body: unknown, etag: string | undefined) {
  const request = requestValue(workflowExportRequestSchema, body);
  if (request.source.kind === 'draft' && etag === undefined)
    return invalidArgument('Draft export requires its reviewed --etag.');
  if (request.source.kind === 'version' && etag !== undefined)
    return invalidArgument('Version export does not accept a draft --etag.');
  return request;
}

const runStatus = z.object({ run: z.object({ status: z.string() }) });
const SETTLED_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
const FIRST_POLL_MS = 1_000;
const LONGEST_POLL_MS = 15_000;

/** A failed run is still an answer; the script reads `run.status` from the output. */
async function waitForRun(
  read: (signal: AbortSignal) => Promise<AutomationHttpResponse>,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<object> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, timeoutSeconds * 1_000);
  const waitSignal = AbortSignal.any([signal, timeout.signal]);
  let status: string | undefined;
  try {
    for (
      let pause = FIRST_POLL_MS;
      ;
      pause = Math.min(pause * 2, LONGEST_POLL_MS)
    ) {
      const response = await read(waitSignal);
      // A response completing after the deadline is not a successful bounded wait.
      if (timeout.signal.aborted || Date.now() >= deadline)
        throw waitTimedOut(status, timeoutSeconds);
      const observed = runStatus.safeParse(response.body).data?.run.status;
      if (observed === undefined)
        throw new AutomationCommandError(
          'cli.invalid_response',
          'The server response has no run status.',
        );
      status = observed;
      if (SETTLED_STATUSES.has(status)) return responseValue(response);
      const remaining = deadline - Date.now();
      // A poll at or past the deadline couldn't count, so don't send one:
      // wait out the deadline and report the timeout.
      await sleep(Math.max(0, Math.min(pause, remaining)), undefined, {
        signal: waitSignal,
      });
      if (remaining <= pause) throw waitTimedOut(status, timeoutSeconds);
    }
  } catch (error: unknown) {
    if (signal.aborted)
      throw new AutomationCommandError(
        'cli.transport_failure',
        'Command interrupted.',
      );
    if (timeout.signal.aborted || Date.now() >= deadline)
      throw waitTimedOut(status, timeoutSeconds);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function waitTimedOut(
  status: string | undefined,
  timeoutSeconds: number,
): AutomationCommandError {
  const detail =
    status === undefined
      ? `No run status was received within ${String(timeoutSeconds)} seconds.`
      : `Waiting stopped after ${String(timeoutSeconds)} seconds; the last reported run status was ${status}.`;
  return new AutomationCommandError(
    'cli.wait_timed_out',
    `${detail} Any run still in progress keeps going; wait again or read it with runs get.`,
  );
}

function commandHeaders(command: AutomationArguments) {
  return {
    ...(!('key' in command) ? {} : { 'Idempotency-Key': command.key }),
    ...(!('etag' in command) || command.etag === undefined
      ? {}
      : { 'If-Match': command.etag }),
  };
}
