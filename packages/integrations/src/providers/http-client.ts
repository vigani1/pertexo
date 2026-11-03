import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';
import {
  ProviderHttpError,
  inspectProviderHttpError,
  type ProviderHttpErrorCode,
} from './http.errors.js';

export type ProviderHttpRequest = Readonly<{
  url: string;
  method: 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array | NodeVerifiedByteSource;
  timeoutMillis: number;
  maxRedirects: number;
  maxResponseBytes: number;
  sensitiveValues?: readonly string[];
  /** Private page navigation; never returned as step output or observation metadata. */
  navigation?: Readonly<{ origin: string; link: boolean }>;
  signal?: AbortSignal;
  beforeDispatch(): Promise<void>;
}>;

export type ProviderHttpResponse<Body = Uint8Array> = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Body;
  bodyEncoding: 'base64' | 'utf8';
  finalUrl: string;
  redirectCount: number;
}>;

export type ProviderHttpStreamingBody = Readonly<{
  navigation?: Readonly<{ url: string; link?: string }>;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
  cancelSource?: (reason: Error) => void;
  bodyEncoding: 'base64' | 'utf8';
  finalUrl: string;
  redirectCount: number;
  signal: AbortSignal;
}>;

export type ProviderHttpBodyConsumer<Body> = (
  response: ProviderHttpStreamingBody,
) => Promise<Body>;

/** Provider operations receive HTTP facts and bytes, without DNS, sockets or key custody. */
export interface ProviderHttpClient {
  execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
  executeStreaming<Body>(
    request: ProviderHttpRequest,
    consume: ProviderHttpBodyConsumer<Body>,
  ): Promise<ProviderHttpResponse<Body>>;
  redactText(value: string, sensitiveValues: readonly string[]): string;
}

type HttpFailure = Readonly<{
  code: ProviderHttpErrorCode;
  classification: 'ambiguous' | 'definite_failure';
  possiblyDispatched: boolean;
}>;
export type ProviderHttpSecurity = Readonly<{
  inspectError(error: unknown): HttpFailure | undefined;
  createError(failure: HttpFailure): Error;
  redactText(value: string, sensitiveValues: readonly string[]): string;
}>;

/** Translates the injected network's failure contract at the provider port. */
export function createProviderHttpClient(
  client: Pick<ProviderHttpClient, 'execute' | 'executeStreaming'>,
  security: ProviderHttpSecurity,
): ProviderHttpClient {
  const request = (input: ProviderHttpRequest): ProviderHttpRequest => ({
    ...input,
    beforeDispatch: async () => {
      try {
        await input.beforeDispatch();
      } catch (error: unknown) {
        const failure = inspectProviderHttpError(error);
        if (failure === undefined) throw error;
        throw security.createError(failure);
      }
    },
  });
  const execute = async <Result>(
    work: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await work();
    } catch (error: unknown) {
      const failure = security.inspectError(error);
      if (failure === undefined) throw error;
      throw new ProviderHttpError(
        failure.code,
        failure.classification,
        failure,
      );
    }
  };
  return Object.freeze({
    execute: (input: ProviderHttpRequest) =>
      execute(() => client.execute(request(input))),
    executeStreaming: <Body>(
      input: ProviderHttpRequest,
      consume: ProviderHttpBodyConsumer<Body>,
    ) => execute(() => client.executeStreaming(request(input), consume)),
    redactText: security.redactText,
  });
}
