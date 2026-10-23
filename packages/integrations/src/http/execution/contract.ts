import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';

import type { SecureHttpErrorCode } from '../secure-error.js';
import type {
  AllowedPrivateNetwork,
  ResolvedAddress,
} from '../transport/address-policy.js';

/**
 * The HTTP request step's policy: the private networks its operator allows
 * (HTTP_ALLOWED_PRIVATE_NETWORKS), and plain http only inside them. Clients
 * without one keep the public-only rule.
 */
export type SecureHttpAddressPolicy = Readonly<{
  allowedPrivateNetworks: readonly AllowedPrivateNetwork[];
}>;

export type SecureHttpFailureStage =
  | 'admission'
  | 'cancellation'
  | 'dns'
  | 'pre_dispatch'
  | 'redirect'
  | 'response'
  | 'transport';

export type SecureHttpFailureObservation = Readonly<{
  classification: 'ambiguous' | 'definite_failure';
  durationSeconds: number;
  possiblyDispatched: boolean;
  reason: SecureHttpErrorCode;
  stage: SecureHttpFailureStage;
}>;

export interface SecureHttpObserver {
  observeFailure(observation: SecureHttpFailureObservation): void;
}

export type SecureHttpRequest = Readonly<{
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

export type SecureHttpResponse<Body = Uint8Array> = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Body;
  bodyEncoding: 'base64' | 'utf8';
  finalUrl: string;
  redirectCount: number;
}>;

export type SecureHttpStreamingBody = Readonly<{
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

export type SecureHttpBodyConsumer<Body> = (
  response: SecureHttpStreamingBody,
) => Promise<Body>;

export interface SecureHttpResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export type SecureHttpTransportRequest = Readonly<{
  url: URL;
  address: ResolvedAddress;
  method: SecureHttpRequest['method'];
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array | NodeVerifiedByteSource;
  timeoutMillis: number;
  signal?: AbortSignal;
}>;

export type SecureHttpTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}>;

export interface SecureHttpTransport {
  dispatch(
    request: SecureHttpTransportRequest,
  ): Promise<SecureHttpTransportResponse>;
}

export type RedirectState = Readonly<{
  url: URL;
  method: SecureHttpRequest['method'];
  body?: Uint8Array | NodeVerifiedByteSource;
  headers: Readonly<Record<string, string>>;
  redirectCount: number;
}>;

export type DispatchFailureContext = Readonly<{
  possiblyDispatched: boolean;
  ambiguous: boolean;
}>;

export const POST_DISPATCH_AMBIGUITY: DispatchFailureContext = Object.freeze({
  possiblyDispatched: true,
  ambiguous: true,
});
