import { HttpPaginationFailure } from './failure.js';
import timers from 'node:timers/promises';
import {
  canonicalizeBoundedJson,
  NODE_EXECUTION_LIMITS,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { inspectJsonValue, resolveJsonPath } from '@pertexo/workflow-model';
import { inspectSecureHttpError } from '../../http/secure-error.js';
import type {
  SecureHttpClient,
  SecureHttpRequest,
  SecureHttpStreamingBody,
} from '../../http/secure.js';
import type { HttpPagination } from './validation.js';
import { nextPage, setPaginationParameter } from './navigation.js';
import { JSON_MEDIA_TYPE } from '../../http/content-type.js';

type Page = Readonly<{ value: JsonValue; url: string; link?: string }>;
async function readPage(
  stream: SecureHttpStreamingBody,
  page: number,
): Promise<Page> {
  if (
    stream.navigation === undefined ||
    !JSON_MEDIA_TYPE.test(stream.headers['content-type'] ?? '')
  )
    throw new HttpPaginationFailure('http.pagination_invalid_page', page);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream.body) {
      chunks.push(new Uint8Array(chunk));
      size += chunk.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      return {
        value: canonicalizeBoundedJson(value),
        url: stream.navigation.url,
        ...(stream.navigation.link === undefined
          ? {}
          : { link: stream.navigation.link }),
      };
    } catch {
      throw new HttpPaginationFailure('http.pagination_invalid_page', page);
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function executePagination(
  input: Readonly<{
    client: Pick<SecureHttpClient, 'executeStreaming'>;
    request: SecureHttpRequest;
    pagination: HttpPagination;
    inlineBytes: number;
    deadlineAt?: Date;
    checkResponse(
      status: number,
      headers: Readonly<Record<string, string>>,
    ): void;
  }>,
) {
  const { pagination, request } = input;
  request.signal?.throwIfAborted();
  if (
    input.deadlineAt !== undefined &&
    pagination.maxPages * (request.timeoutMillis + pagination.delayMillis) >
      input.deadlineAt.getTime() - Date.now()
  )
    throw new HttpPaginationFailure('http.pagination_budget_exceeded', 1);
  const first = new URL(request.url);
  if (pagination.mode === 'page' || pagination.mode === 'offset')
    setPaginationParameter(
      first,
      pagination.parameter,
      String(pagination.start),
    );
  let url = first.toString();
  const seen = new Set<string>(pagination.mode === 'cursor' ? [] : [url]);
  if (pagination.mode === 'cursor') {
    const cursor = first.searchParams.get(pagination.parameter);
    if (cursor !== null) seen.add(cursor);
  }
  const items: JsonValue[] = [];
  let itemBytes = 0;
  let itemMembers = 0;
  let itemDepth = 1;
  for (let page = 1; page <= pagination.maxPages; page += 1) {
    request.signal?.throwIfAborted();
    let response;
    try {
      response = await input.client.executeStreaming(
        {
          ...request,
          url,
          maxResponseBytes: input.inlineBytes,
          navigation: {
            origin: first.origin,
            link:
              pagination.mode === 'next_link' &&
              pagination.source.kind === 'link_header',
          },
        },
        async (stream) => {
          input.checkResponse(stream.status, stream.headers);
          return readPage(stream, page);
        },
      );
    } catch (error) {
      const code = inspectSecureHttpError(error)?.code;
      if (code === 'pagination_origin_changed')
        throw new HttpPaginationFailure('http.pagination_origin_changed', page);
      if (code === 'pagination_navigation_invalid')
        throw new HttpPaginationFailure(
          'http.pagination_invalid_navigation',
          page,
        );
      if (
        code === 'response_too_large' ||
        code === 'response_encoding_rejected'
      )
        throw new HttpPaginationFailure('http.pagination_invalid_page', page);
      throw error;
    }
    const found = resolveJsonPath(response.body.value, pagination.itemsPath);
    if (found.kind !== 'value' || !Array.isArray(found.value))
      throw new HttpPaginationFailure('http.pagination_invalid_page', page);
    const pageItems = found.value as readonly JsonValue[];
    const added = inspectJsonValue(pageItems);
    itemBytes +=
      added.bytes - 2 + (items.length > 0 && pageItems.length > 0 ? 1 : 0);
    itemMembers += added.members;
    itemDepth = Math.max(itemDepth, added.depth);
    const next =
      found.value.length === 0 || page === pagination.maxPages
        ? undefined
        : nextPage({ pagination, first, current: response.body, page, seen });
    const output = {
      items,
      pageCount: page,
      complete:
        pageItems.length === 0 ||
        (page < pagination.maxPages && next === undefined),
      status: response.status,
      headers: response.headers,
      finalOrigin: response.finalUrl,
    };
    const envelope = inspectJsonValue({ ...output, items: [] });
    if (
      envelope.bytes + itemBytes > NODE_EXECUTION_LIMITS.bytes ||
      envelope.members + itemMembers > NODE_EXECUTION_LIMITS.members ||
      Math.max(envelope.depth, itemDepth + 1) > NODE_EXECUTION_LIMITS.depth
    )
      throw new HttpPaginationFailure('http.pagination_too_large', page);
    for (const item of pageItems) items.push(item);
    if (next === undefined || page === pagination.maxPages) return output;
    url = next;
    if (pagination.delayMillis > 0)
      await timers.setTimeout(pagination.delayMillis, undefined, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
  }
  throw new Error('Pagination bound exhausted without a result');
}
