import { MODEL_LIMITS } from './model-settings.js';
import { AGENT_TOOL_LIMITS } from '@pertexo/workflow-model';
import { NodeExecutorFailure, safeInstanceOf } from '@pertexo/node-sdk/server';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
} from '../http/outcome-policy.js';
import type { ProviderHttpClient } from '../providers/http-client.js';
import {
  inspectProviderHttpError,
  PROVIDER_HTTP_ERROR_CODE,
} from '../providers/http.errors.js';
import { chatCompletions } from './chat-completions.js';
import {
  modelEndpoint,
  modelHeaders,
  type ModelCredential,
} from './connections.definition.js';
import { messages } from './messages.js';
import { modelFailure } from './model/model.errors.js';

import type { trackModelUsage } from './model-usage.js';
import type { ModelRequest } from './model-request.js';

const repeatable = { providerKeyPresent: false };

export type ModelClient = ReturnType<typeof createModelClient>;

export function createModelClient(
  http: Pick<ProviderHttpClient, 'executeStreaming'>,
) {
  return {
    async complete(
      request: ModelRequest,
      context: Readonly<{
        credential: ModelCredential;
        signal: AbortSignal;
        timeoutMillis: number;
        earlierDispatch: boolean;
        usage: ReturnType<typeof trackModelUsage>;
        beforeDispatch(): Promise<void>;
      }>,
    ) {
      const {
        credential,
        beforeDispatch,
        signal,
        timeoutMillis,
        earlierDispatch,
        usage,
      } = context;
      const adapter =
        request.endpoint === 'anthropic' ? messages : chatCompletions;
      const body = new TextEncoder().encode(
        JSON.stringify(adapter.request(request)),
      );
      let dispatched = earlierDispatch;
      try {
        const requestBytes =
          request.agent === undefined
            ? MODEL_LIMITS.requestBytes
            : AGENT_TOOL_LIMITS.requestBytes;
        if (body.byteLength > requestBytes)
          throw modelFailure('request_too_large', {
            possiblyDispatched: dispatched,
          });
        const response = await http.executeStreaming(
          {
            url: modelEndpoint(credential, adapter.path),
            headers: {
              ...modelHeaders(credential),
              'content-type': 'application/json',
            },
            method: 'POST',
            body,
            timeoutMillis,
            signal,
            maxRedirects: 0,
            maxResponseBytes: MODEL_LIMITS.responseBytes,
            sensitiveValues: [credential.apiKey],
            rejectSensitiveResponse: true,
            beforeDispatch: async () => {
              await beforeDispatch();
              dispatched = true;
              usage.dispatched();
            },
          },
          async ({ status, body: stream }) => {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let text = '';
            try {
              for await (const chunk of stream)
                text += decoder.decode(chunk, { stream: true });
              return parseJson(text + decoder.decode());
            } catch (error: unknown) {
              if (status >= 200 && status < 300) throw error;
              return undefined;
            }
          },
        );
        usage.received(adapter.usage(response.body));
        const outcome = classifySecureHttpResponse(response.status, 'safe', {
          ...repeatable,
          headers: response.headers,
        });
        if (outcome.kind !== 'succeeded')
          throw statusFailure(response.status, outcome);
        const result = adapter.completion(response.body, request);
        if (
          result.kind === 'text' ||
          result.kind === 'structured' ||
          result.kind === 'proposal'
        )
          return result;
        throw modelFailure(result.kind, { possiblyDispatched: true });
      } catch (error: unknown) {
        if (safeInstanceOf(error, NodeExecutorFailure)) throw error;
        throw transportFailure(error, signal, dispatched);
      } finally {
        body.fill(0);
      }
    },
  };
}

function statusFailure(
  status: number,
  outcome: Exclude<
    ReturnType<typeof classifySecureHttpResponse>,
    { kind: 'succeeded' }
  >,
) {
  const options = { possiblyDispatched: true };
  if (outcome.kind === 'failed' && outcome.reason === 'retry_after_exceeded')
    return modelFailure('retry_after_exceeded', options);
  if (outcome.errorKind === 'authentication')
    return modelFailure('credential_rejected', options);
  if (status === 400 || status === 404 || status === 422)
    return modelFailure('model_unavailable', options);
  if (outcome.kind === 'retry') {
    const retry = {
      ...options,
      kind: 'retry' as const,
      minimumRetryDelayMillis: outcome.minimumRetryDelayMillis,
    };
    if (outcome.errorKind === 'rate_limit')
      return modelFailure('rate_limited', retry);
    if (outcome.errorKind === 'timeout')
      return modelFailure('provider_timeout', retry);
    return new NodeExecutorFailure({ ...retry, errorKind: outcome.errorKind });
  }
  return modelFailure('invalid_response', options);
}

function transportFailure(
  error: unknown,
  signal: AbortSignal,
  possiblyDispatched: boolean,
) {
  const options = { possiblyDispatched };
  if (signal.aborted) {
    return signal.reason instanceof DOMException &&
      signal.reason.name === 'TimeoutError'
      ? modelFailure('provider_timeout', { ...options, kind: 'retry' })
      : new NodeExecutorFailure({
          ...options,
          kind: 'canceled',
          errorKind: 'canceled',
        });
  }
  const secure = inspectProviderHttpError(error);
  if (secure === undefined) return modelFailure('invalid_response', options);
  const { code } = secure;
  if (
    code === PROVIDER_HTTP_ERROR_CODE.ssrfBlocked ||
    code === PROVIDER_HTTP_ERROR_CODE.redirectRejected
  )
    return modelFailure('address_denied', options);
  if (code === PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed)
    return modelFailure('credential_rejected', options);
  if (code === PROVIDER_HTTP_ERROR_CODE.responseSensitive)
    return modelFailure('credential_echoed', options);
  if (code === PROVIDER_HTTP_ERROR_CODE.responseTooLarge)
    return modelFailure('response_too_large', options);
  const decision = classifySecureHttpError(secure, 'safe', repeatable);
  if (decision.kind === 'succeeded')
    return modelFailure('invalid_response', options);
  if (decision.errorKind === 'timeout')
    return modelFailure('provider_timeout', { ...options, kind: 'retry' });
  return new NodeExecutorFailure({
    ...options,
    kind: decision.kind,
    errorKind: decision.errorKind,
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
