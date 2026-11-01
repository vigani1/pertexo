import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  failure,
  inspectSecureHttpError,
} from './secure-error.js';
import {
  assertPublicAddress,
  isAllowedPrivateAddress,
  normalizeUrlHostname,
  type ResolvedAddress,
} from './transport/address-policy.js';
import { parseRequest } from './secure-request.js';

import {
  type SecureHttpAddressPolicy,
  type SecureHttpObserver,
  type SecureHttpRequest,
  type SecureHttpResponse,
  type SecureHttpBodyConsumer,
  type SecureHttpResolver,
  type SecureHttpTransportResponse,
  type SecureHttpTransport,
  type RedirectState,
  type DispatchFailureContext,
  POST_DISPATCH_AMBIGUITY,
} from './execution/contract.js';
import {
  assertResponseStatus,
  redirectTransition,
  parseTargetUrl,
  literalAddressFamily,
  redirectLocation,
} from './execution/routing.js';
import { consumeFinalResponse, collectBody } from './execution/response.js';
import {
  failureStage,
  assertNotAborted,
  mapTransportError,
  raceWithSignal,
} from './execution/cancellation.js';
export {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpErrorCode,
} from './secure-error.js';
export {
  type SecureHttpAddressPolicy,
  type SecureHttpFailureStage,
  type SecureHttpFailureObservation,
  type SecureHttpObserver,
  type SecureHttpRequest,
  type SecureHttpResponse,
  type SecureHttpStreamingBody,
  type SecureHttpBodyConsumer,
  type SecureHttpResolver,
  type SecureHttpTransportRequest,
  type SecureHttpTransportResponse,
  type SecureHttpTransport,
} from './execution/contract.js';
export function secureHttpPreDispatchError(
  code:
    | typeof SECURE_HTTP_ERROR_CODE.connectionFenceFailed
    | typeof SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch
    | typeof SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
): SecureHttpError {
  return new SecureHttpError(code, 'definite_failure', {
    possiblyDispatched: false,
  });
}

export class SecureHttpClient {
  public constructor(
    private readonly resolver: SecureHttpResolver,
    private readonly transport: SecureHttpTransport,
    private readonly observer?: SecureHttpObserver,
    private readonly addressPolicy?: SecureHttpAddressPolicy,
  ) {}

  /**
   * Whether a request to this address would be refused, for when a refusal after
   * dispatching would cost something. A name that doesn't resolve isn't refused:
   * that may pass, and the request itself will say.
   */
  public async isAddressBlocked(
    url: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.resolvePublic(
        parseTargetUrl(url),
        Object.freeze({ possiblyDispatched: false, ambiguous: false }),
        signal,
      );
      return false;
    } catch (error: unknown) {
      return (
        inspectSecureHttpError(error)?.code ===
        SECURE_HTTP_ERROR_CODE.ssrfBlocked
      );
    }
  }

  public execute(input: SecureHttpRequest): Promise<SecureHttpResponse> {
    return this.executeStreaming(input, async (response) =>
      collectBody(response.body),
    );
  }

  public executeStreaming<Body>(
    input: SecureHttpRequest,
    consume: SecureHttpBodyConsumer<Body>,
  ): Promise<SecureHttpResponse<Body>> {
    return this.executeWithBody(input, consume);
  }

  private async executeWithBody<Body>(
    input: SecureHttpRequest,
    consume: SecureHttpBodyConsumer<Body>,
  ): Promise<SecureHttpResponse<Body>> {
    const startedAt = performance.now();
    let parsed: ReturnType<typeof parseRequest> | undefined;
    try {
      parsed = parseRequest(input);
      return await this.executeOwnedRequest(parsed, consume);
    } catch (error: unknown) {
      const secureError = inspectSecureHttpError(error);
      if (secureError !== undefined) {
        try {
          this.observer?.observeFailure({
            classification: secureError.classification,
            durationSeconds: (performance.now() - startedAt) / 1_000,
            possiblyDispatched: secureError.possiblyDispatched,
            reason: secureError.code,
            stage: failureStage(secureError.code),
          });
        } catch {
          // Diagnostics must never alter provider request behavior.
        }
      }
      throw error;
    } finally {
      if (parsed?.body instanceof Uint8Array) parsed.body.fill(0);
    }
  }

  private async executeOwnedRequest<Body>(
    parsed: ReturnType<typeof parseRequest>,
    consume: SecureHttpBodyConsumer<Body>,
  ): Promise<SecureHttpResponse<Body>> {
    const deadline = performance.now() + parsed.timeoutMillis;
    const timeoutSignal = AbortSignal.timeout(parsed.timeoutMillis);
    const executionSignal =
      parsed.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([parsed.signal, timeoutSignal]);
    let requestState: RedirectState = Object.freeze({
      url: parseTargetUrl(parsed.url),
      method: parsed.method,
      ...(parsed.body === undefined ? {} : { body: parsed.body }),
      headers: parsed.headers,
      redirectCount: 0,
    });
    let markerCommitted = false;

    for (;;) {
      const resolutionFailureContext: DispatchFailureContext = Object.freeze({
        possiblyDispatched: markerCommitted,
        ambiguous: false,
      });
      assertNotAborted(executionSignal, resolutionFailureContext);
      const address = await this.resolvePublic(
        requestState.url,
        resolutionFailureContext,
        executionSignal,
      );
      if (!markerCommitted) {
        try {
          await parsed.beforeDispatch();
          markerCommitted = true;
          assertNotAborted(executionSignal, POST_DISPATCH_AMBIGUITY);
        } catch (error: unknown) {
          const secureError = inspectSecureHttpError(error);
          if (secureError !== undefined) throw secureError.error;
          throw failure(SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed, {
            possiblyDispatched: false,
            ambiguous: false,
            cause: error,
          });
        }
      }
      let response: SecureHttpTransportResponse;
      try {
        response = await raceWithSignal(
          this.transport.dispatch({
            url: requestState.url,
            address,
            method: requestState.method,
            headers: requestState.headers,
            ...(requestState.body === undefined
              ? {}
              : { body: requestState.body }),
            timeoutMillis: parsed.timeoutMillis,
            signal: executionSignal,
          }),
          executionSignal,
          POST_DISPATCH_AMBIGUITY,
          (lateResponse) => {
            lateResponse.close();
          },
        );
      } catch (error: unknown) {
        const secureError = inspectSecureHttpError(error);
        if (secureError !== undefined) throw secureError.error;
        throw mapTransportError(error, executionSignal);
      }
      assertResponseStatus(response);

      const location = redirectLocation(response);
      if (location !== undefined) {
        response.close();
        requestState = redirectTransition(
          response,
          requestState,
          parsed,
          location,
        );
        continue;
      }
      return await consumeFinalResponse(response, requestState, parsed, {
        executionSignal,
        deadline,
        consume,
      });
    }
  }

  private async resolvePublic(
    url: URL,
    failureContext: DispatchFailureContext,
    signal: AbortSignal,
  ): Promise<ResolvedAddress> {
    const hostname = normalizeUrlHostname(url.hostname);
    let addresses: readonly ResolvedAddress[];
    try {
      const literalFamily = literalAddressFamily(hostname);
      addresses =
        literalFamily === undefined
          ? await raceWithSignal(
              this.resolver.resolve(hostname),
              signal,
              failureContext,
            )
          : [{ address: hostname, family: literalFamily }];
    } catch (error: unknown) {
      const secureError = inspectSecureHttpError(error);
      if (secureError !== undefined) throw secureError.error;
      throw failure(SECURE_HTTP_ERROR_CODE.dnsFailed, {
        possiblyDispatched: failureContext.possiblyDispatched,
        ambiguous: false,
        cause: error,
      });
    }
    if (addresses.length === 0 || addresses.length > 16)
      throw failure(SECURE_HTTP_ERROR_CODE.dnsFailed, {
        possiblyDispatched: failureContext.possiblyDispatched,
        ambiguous: false,
      });
    const validated: ResolvedAddress[] = [];
    const policy = this.addressPolicy;
    try {
      for (const candidate of addresses) {
        const permitted =
          policy !== undefined &&
          isAllowedPrivateAddress(
            candidate.address,
            policy.allowedPrivateNetworks,
          );
        const family = permitted
          ? candidate.family
          : assertPublicAddress(candidate.address);
        if (family !== candidate.family)
          throw new Error('address family mismatch');
        // Plain http only inside a network the operator allowed.
        if (policy !== undefined && url.protocol === 'http:' && !permitted)
          throw new Error('plain http to a public address');
        validated.push(Object.freeze({ ...candidate }));
      }
    } catch (error: unknown) {
      throw failure(SECURE_HTTP_ERROR_CODE.ssrfBlocked, {
        possiblyDispatched: failureContext.possiblyDispatched,
        ambiguous: false,
        cause: error,
      });
    }
    validated.sort((left, right) =>
      `${String(left.family)}:${left.address}`.localeCompare(
        `${String(right.family)}:${right.address}`,
      ),
    );
    const selected = validated[0];
    if (selected === undefined)
      throw failure(SECURE_HTTP_ERROR_CODE.dnsFailed, {
        possiblyDispatched: failureContext.possiblyDispatched,
        ambiguous: false,
      });
    return selected;
  }
}
