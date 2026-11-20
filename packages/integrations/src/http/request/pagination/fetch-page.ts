import {
  canonicalizeBoundedJson,
  type JsonValue,
} from '@pertexo/node-sdk/server';
import { inspectProviderHttpError } from '../../../providers/http.errors.js';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpStreamingBody,
} from '../../../providers/http-client.js';
import { JSON_MEDIA_TYPE } from '../../content-type.js';
import { HttpPaginationFailure } from './pagination.errors.js';

export async function fetchPage(
  input: Readonly<{
    client: Pick<ProviderHttpClient, 'executeStreaming'>;
    request: ProviderHttpRequest;
    inlineBytes: number;
    checkResponse(
      status: number,
      headers: Readonly<Record<string, string>>,
    ): void;
  }>,
  {
    url,
    origin,
    page,
    link,
  }: Readonly<{
    url: string;
    origin: string;
    page: number;
    link: boolean;
  }>,
) {
  const { request } = input;
  try {
    return await input.client.executeStreaming(
      {
        ...request,
        url,
        maxResponseBytes: input.inlineBytes,
        navigation: {
          origin,
          link,
        },
      },
      async (stream) => {
        input.checkResponse(stream.status, stream.headers);
        return readPage(stream, page);
      },
    );
  } catch (error) {
    const code = inspectProviderHttpError(error)?.code;
    if (code === 'pagination_origin_changed')
      throw new HttpPaginationFailure('http.pagination_origin_changed', page);
    if (code === 'pagination_navigation_invalid')
      throw new HttpPaginationFailure(
        'http.pagination_invalid_navigation',
        page,
      );
    if (code === 'response_too_large' || code === 'response_encoding_rejected')
      throw new HttpPaginationFailure('http.pagination_invalid_page', page);
    throw error;
  }
}

export type Page = Readonly<{ value: JsonValue; url: string; link?: string }>;
async function readPage(
  stream: ProviderHttpStreamingBody,
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
