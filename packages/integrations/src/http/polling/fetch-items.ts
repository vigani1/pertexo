import type { NodeConnectionRuntime } from '@pertexo/node-sdk/server';
import {
  resolveJsonPath,
  utf8ByteLength,
  type JsonValue,
  type HttpPollConfig,
} from '@pertexo/workflow-model';
import {
  canonicalEventKey,
  hashPollItemKey,
} from '@pertexo/workflow-model/server';
import type { ProviderHttpClient } from '../../providers/http-client.js';
import { createProviderBeforeDispatch } from '../../providers/provider-dispatch-fence.js';
import {
  HTTP_REQUEST_CREDENTIAL_PURPOSE,
  credentialSensitiveValues,
  withHttpCredentialHeaders,
} from '../request/execution/credentials.js';
import { requestClient } from '../request/execution/request-client.js';
import { fetchPage } from '../request/pagination/fetch-page.js';
import { nextPage } from '../request/pagination/navigation.js';
import {
  HTTP_REQUEST_LIMITS,
  safeRequestUrl,
} from '../request/request.schemas.js';
import {
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
} from '../outcome-policy.js';
import { HttpPollFailure, pollFailure } from './polling.errors.js';

type PollInput = Readonly<{
  config: HttpPollConfig;
  connectionId?: string;
  seenKeys: readonly string[];
  maxItems: number;
  maxPages: number;
  signal: AbortSignal;
}>;

type PollDependencies = Readonly<{
  httpClient: Pick<ProviderHttpClient, 'executeStreaming'>;
  connections?: NodeConnectionRuntime;
}>;

export async function fetchHttpPollItems(
  input: PollInput,
  { httpClient, connections }: PollDependencies,
) {
  const { config, connectionId } = input;
  const deadline = AbortSignal.timeout(
    HTTP_REQUEST_LIMITS.defaultTimeoutMillis,
  );
  const signal = AbortSignal.any([input.signal, deadline]);
  try {
    signal.throwIfAborted();
    if (
      !safeRequestUrl(config.url) ||
      utf8ByteLength(config.url) > HTTP_REQUEST_LIMITS.maxUrlBytes
    )
      throw new HttpPollFailure('http.poll_navigation_denied');
    const resolved =
      connectionId === undefined
        ? undefined
        : await resolveCredential(connectionId, connections, signal);
    const beforeDispatch =
      resolved === undefined || connections?.assertCurrent === undefined
        ? undefined
        : createProviderBeforeDispatch({
            assertCurrent: connections.assertCurrent,
            connectionId: resolved.connectionId,
            expectedProviderKey: 'http',
            expectedAuthType: resolved.authType,
            secretVersionId: resolved.secretVersionId,
            signal,
          });
    return await withHttpCredentialHeaders(
      resolved,
      connectionId,
      (headers = {}) =>
        collectItems(input, {
          client: requestClient(
            httpClient,
            {
              connections,
              connectionId,
              signal,
              onCredentialError: pollFailure,
            },
            resolved,
          ),
          request: {
            url: config.url,
            method: 'GET',
            headers,
            sensitiveValues: credentialSensitiveValues(headers),
            signal,
            timeoutMillis: HTTP_REQUEST_LIMITS.defaultTimeoutMillis,
            maxRedirects: HTTP_REQUEST_LIMITS.defaultRedirects,
            maxResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
            beforeDispatch:
              beforeDispatch ??
              (() =>
                Promise.resolve().then(() => {
                  signal.throwIfAborted();
                })),
          },
          inlineBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
          checkResponse,
        }),
    );
  } catch (error: unknown) {
    input.signal.throwIfAborted();
    if (deadline.aborted)
      throw new HttpPollFailure('http.poll_deadline_exceeded');
    throw pollFailure(error);
  }
}

async function resolveCredential(
  connectionId: string,
  connections: NodeConnectionRuntime | undefined,
  signal: AbortSignal,
) {
  if (
    connections?.resolveHttpCredential === undefined ||
    connections.assertCurrent === undefined
  )
    throw new HttpPollFailure('http.poll_authentication');
  const credential = await connections.resolveHttpCredential({
    connectionId,
    purpose: HTTP_REQUEST_CREDENTIAL_PURPOSE,
    signal,
  });
  if (
    credential.authType === 'oauth2' &&
    (credential.connectionId !== connectionId ||
      credential.providerKey !== 'http')
  )
    throw new HttpPollFailure('http.poll_authentication');
  return credential;
}

async function collectItems(
  { config, seenKeys, maxItems, maxPages }: PollInput,
  pageRequest: Parameters<typeof fetchPage>[0],
) {
  const first = new URL(config.url);
  const visited = new Set([first.href]);
  const seen = new Set(seenKeys);
  const items: { key: string | number; item: JsonValue }[] = [];
  let url = first.href;
  for (let page = 1; page <= maxPages; page++) {
    pageRequest.request.signal?.throwIfAborted();
    const { body } = await fetchPage(pageRequest, {
      url,
      origin: first.origin,
      page,
      link: true,
    });
    const found = resolveJsonPath(body.value, config.itemsPath);
    if (found.kind !== 'value' || !Array.isArray(found.value))
      throw new HttpPollFailure('http.poll_invalid_items');
    const inspected = (found.value as readonly JsonValue[]).slice(
      0,
      maxItems - items.length,
    );
    let allSeen = inspected.length > 0;
    for (const item of inspected) {
      const key = itemKey(item, config.itemKeyPath);
      if (!seen.has(hashPollItemKey(key))) allSeen = false;
      items.push({ key, item });
    }
    if (allSeen || items.length === maxItems || page === maxPages) break;
    const next = nextPage({
      pagination: { mode: 'next_link', source: { kind: 'link_header' } },
      first,
      current: body,
      page,
      seen: visited,
    });
    if (next.kind !== 'next') break;
    url = next.url;
  }
  return items;
}

function itemKey(item: JsonValue, path: string): string | number {
  const found = resolveJsonPath(item, path);
  if (
    found.kind !== 'value' ||
    (typeof found.value !== 'string' && typeof found.value !== 'number') ||
    canonicalEventKey(found.value) === undefined
  )
    throw new HttpPollFailure('http.poll_invalid_key');
  return found.value;
}

function checkResponse(
  status: number,
  headers: Readonly<Record<string, string>>,
): void {
  const outcome = classifySecureHttpResponse(
    status,
    HTTP_SIDE_EFFECT_CLASS.safe,
    {
      providerKeyPresent: false,
      headers,
    },
  );
  if (outcome.kind === 'succeeded') return;
  if (outcome.errorKind === 'authentication')
    throw new HttpPollFailure('http.poll_authentication');
  if (outcome.errorKind === 'rate_limit')
    throw new HttpPollFailure('http.poll_rate_limited');
  throw new HttpPollFailure('http.poll_response_failed');
}
