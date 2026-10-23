import { apiProblemSchema, type ApiProblem } from '@pertexo/contracts';
import type { AutomationHttpConfig } from './config.js';
import { AutomationCommandError } from './errors.js';
import { MAX_COMMAND_BYTES } from './files.js';

const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
export type AutomationHttpResponse = Readonly<{
  body: unknown;
  etag: string | null;
}>;
export interface AutomationHttpClient {
  request(
    input: Readonly<{
      path: `/v1/${string}`;
      method?: 'GET' | 'POST';
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
      signal: AbortSignal;
      effect: 'read' | 'write';
    }>,
  ): Promise<AutomationHttpResponse>;
}

async function boundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new AutomationCommandError(
      'cli.invalid_response',
      'The server returned an empty response.',
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AutomationCommandError(
          'cli.invalid_response',
          'The response exceeds 16 MB. Request a smaller page.',
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, length),
      ),
    ) as unknown;
  } catch {
    throw new AutomationCommandError(
      'cli.invalid_response',
      'The server returned malformed UTF-8 JSON.',
    );
  }
}
function commonProblem(body: unknown): ApiProblem | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const fields = Object.fromEntries(
    [
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'code',
      'requestId',
      'errors',
    ].flatMap((name) =>
      name in body ? [[name, Reflect.get(body, name)] as const] : [],
    ),
  );
  const parsed = apiProblemSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

export function createAutomationHttpClient(
  config: AutomationHttpConfig,
  fetchRequest: typeof globalThis.fetch = globalThis.fetch,
): AutomationHttpClient {
  const secret = config.credential.slice(
    config.credential.lastIndexOf('.') + 1,
  );
  return {
    async request(input) {
      const method = input.method ?? 'GET';
      const mutating = input.effect === 'write';
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([input.signal, deadline]);
      const body =
        input.body === undefined ? undefined : JSON.stringify(input.body);
      if (body !== undefined && Buffer.byteLength(body) > MAX_COMMAND_BYTES)
        throw new AutomationCommandError(
          'cli.invalid_file',
          'The request exceeds 2 MB.',
        );
      try {
        const response = await fetchRequest(`${config.origin}${input.path}`, {
          method,
          signal,
          redirect: 'error',
          credentials: 'omit',
          headers: {
            ...input.headers,
            Authorization: `Bearer ${config.credential}`,
            Accept: 'application/json, application/problem+json',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
        });
        const media = response.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          media !== 'application/json' &&
          media !== 'application/problem+json'
        )
          throw new AutomationCommandError(
            'cli.invalid_response',
            'The server returned an unexpected content type.',
            undefined,
            { uncertain: mutating },
          );
        const value = await boundedResponse(response);
        const etag = response.headers.get('etag');
        const encoded = JSON.stringify({ body: value, etag });
        if (encoded.includes(config.credential) || encoded.includes(secret))
          throw new AutomationCommandError(
            'cli.invalid_response',
            'The server response contains credential material.',
            undefined,
            { uncertain: mutating },
          );
        if (!response.ok) {
          const problem = commonProblem(value);
          if (problem?.status !== response.status)
            throw new AutomationCommandError(
              'cli.invalid_response',
              'The server returned invalid problem details.',
              undefined,
              { uncertain: mutating },
            );
          throw new AutomationCommandError(
            problem.code,
            problem.detail ?? problem.title,
            problem.requestId,
            { uncertain: mutating && response.status >= 500 },
          );
        }
        return { body: value, etag };
      } catch (cause) {
        if (cause instanceof AutomationCommandError) {
          if (mutating && cause.code === 'cli.invalid_response')
            throw new AutomationCommandError(
              cause.code,
              cause.message,
              cause.requestId,
              { uncertain: true },
            );
          throw cause;
        }
        const message = transportFailureMessage(input.signal, deadline);
        throw new AutomationCommandError(
          'cli.transport_failure',
          message,
          undefined,
          { uncertain: mutating },
        );
      }
    },
  };
}

function transportFailureMessage(
  signal: AbortSignal,
  deadline: AbortSignal,
): string {
  if (signal.aborted) return 'Command interrupted.';
  if (deadline.aborted) return 'The API request timed out.';
  return 'The API could not be reached, or refused a redirect.';
}
