import {
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import type { ProviderHttpClient } from '../../providers/http-client.js';
import {
  registerProviderExecutor,
  type ExecutorTelemetry,
} from '../../providers/provider-executor.js';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_EXECUTOR,
} from './request.definition.js';
import { failedConfiguration } from './request.errors.js';
import type {
  HttpRequestConfig,
  HttpRequestInput,
  HttpRequestOutput,
} from './request.schemas.js';
import { executeHttpRequest } from './lifecycle.js';
import {
  HTTP_REQUEST_CREDENTIAL_PURPOSE,
  withHttpCredentialHeaders,
} from './execution/credentials.js';
import {
  prepareInvocation,
  type RequestConnectionBinding,
} from './execution/invocation.js';
import { fillPlaceholders } from './execution/request-input.js';

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>;
  telemetry?: ExecutorTelemetry<HttpRequestOutput>;
}>;

const httpConnection: RequestConnectionBinding = {
  slot: HTTP_REQUEST_CONNECTION_SLOT,
  providerKey: 'http',
  resolve(connections, input) {
    if (connections.resolveHttpCredential === undefined)
      throw failedConfiguration();
    return connections.resolveHttpCredential({
      ...input,
      purpose: HTTP_REQUEST_CREDENTIAL_PURPOSE,
    });
  },
  withHeaders(resolved, connectionId, run) {
    if ('accessToken' in resolved) {
      if (
        resolved.connectionId !== connectionId ||
        resolved.providerKey !== 'http'
      )
        throw failedConfiguration();
      return run({
        headers: { authorization: `Bearer ${resolved.accessToken}` },
      });
    }
    return withHttpCredentialHeaders(resolved, connectionId, (headers) =>
      run({ headers: headers ?? {} }),
    );
  },
};

function prepareHttpRequest(
  invocation: NodeExecutionInvocation<unknown, unknown>,
) {
  // The registry has already parsed both against the definition's schemas.
  const { config, input } = fillPlaceholders(
    invocation.config as HttpRequestConfig,
    invocation.input as HttpRequestInput,
  );
  if (
    invocation.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT] !== undefined &&
    invocation.runtime?.connections?.resolveHttpCredential === undefined
  )
    throw failedConfiguration();
  return prepareInvocation(invocation, config, input, httpConnection);
}

export function createHttpRequestExecutorRegistration(
  dependencies: HttpRequestExecutorDependencies,
): NodeExecutorRegistration {
  return registerProviderExecutor(
    HTTP_REQUEST_EXECUTOR,
    dependencies.telemetry,
    (invocation) =>
      executeHttpRequest(
        dependencies.httpClient,
        prepareHttpRequest(invocation),
      ),
  );
}
