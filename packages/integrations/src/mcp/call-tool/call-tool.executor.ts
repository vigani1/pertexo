import type { SchemaDocument } from '@pertexo/node-sdk';
import {
  NodeExecutorFailure,
  withProviderCredential,
  type NodeExecutionInvocation,
} from '@pertexo/node-sdk/server';
import { canonicalJson } from '@pertexo/workflow-model';
import { createProviderBeforeDispatch } from '../../providers/provider-dispatch-fence.js';
import {
  connectionLookupFailure,
  providerFailure,
} from '../../providers/provider.errors.js';
import {
  inspectProviderHttpError,
  ProviderCredentialRejectedError,
  PROVIDER_HTTP_ERROR_CODE,
} from '../../providers/http.errors.js';
import { registerProviderExecutor } from '../../providers/provider-executor.js';
import { openMcpSession, type McpHttp } from '../client.js';
import {
  MCP_AUTH_TYPE,
  MCP_PROVIDER_KEY,
  mcpCredentialSchema,
} from '../connections.definition.js';
import { listTools, prepareTool } from '../list-tools.js';
import { MCP_LIMITS } from '../mcp-limits.js';
import { McpRpcError } from '../mcp.errors.js';
import { MCP_CALL_TOOL_STEP } from './call-tool.definition.js';
import { callToolFailure } from './call-tool.errors.js';
import type { CallToolConfig } from './call-tool.schemas.js';
import { toolResult } from './tool-result.js';

const failure = providerFailure(NodeExecutorFailure);

export function createCallToolExecutor(
  http: McpHttp,
  now: () => number = Date.now,
) {
  return registerProviderExecutor(MCP_CALL_TOOL_STEP, undefined, (invocation) =>
    callTool(invocation, http, now),
  );
}

async function callTool(
  invocation: NodeExecutionInvocation<unknown, unknown>,
  http: McpHttp,
  now: () => number,
) {
  const { runtime } = invocation;
  const connectionId = invocation.connectionRefs[MCP_AUTH_TYPE];
  const connections = runtime?.connections;
  const assertCurrent = connections?.assertCurrent;
  if (
    runtime?.sideEffectClass !== 'unsafe' ||
    connectionId === undefined ||
    connections === undefined ||
    assertCurrent === undefined
  )
    throw failure('failed', 'configuration', { possiblyDispatched: false });
  if (runtime.providerDispatchUnresolved === true)
    throw callToolFailure('unavailable', 'outcome_unknown', true);

  const budget = Math.min(
    MCP_LIMITS.timeoutMillis,
    (runtime.deadlineAt?.getTime() ?? Infinity) - now(),
  );
  if (budget <= 0) throw callToolFailure('timed_out', 'retry');
  const signal = AbortSignal.any([
    invocation.signal,
    AbortSignal.timeout(budget),
  ]);
  const identity = {
    connectionId,
    expectedProviderKey: MCP_PROVIDER_KEY,
    expectedAuthType: MCP_AUTH_TYPE,
  };
  let resolved;
  try {
    resolved = await connections.resolve({
      ...identity,
      purpose: 'mcp.call_tool.execute',
      signal,
    });
  } catch (error: unknown) {
    throw connectionLookupFailure(error, { failure, runtime, signal });
  }
  const fence = {
    ...identity,
    secretVersionId: resolved.secretVersionId,
    signal,
  };
  const verify = () => assertCurrent(fence);
  const markDispatch = createProviderBeforeDispatch({
    ...fence,
    assertCurrent,
    runtime,
    signal,
  });
  const config = invocation.config as CallToolConfig;
  const args = invocation.input as SchemaDocument;
  return withProviderCredential(
    resolved,
    {
      connectionId,
      providerKey: MCP_PROVIDER_KEY,
      authTypes: [MCP_AUTH_TYPE],
      schema: mcpCredentialSchema,
      refuse: () => callToolFailure('credential_rejected'),
    },
    async (credential) => {
      let dispatched = false;
      try {
        const session = await openMcpSession(credential, {
          http,
          signal,
          beforeDispatch: verify,
        });
        const tool = (await listTools(session)).get(config.toolName);
        if (tool === undefined) throw callToolFailure('schema_changed');
        const prepared = prepareTool(tool);
        if (prepared === undefined) throw callToolFailure('schema_unsupported');
        if (
          canonicalJson(prepared.inputSchema) !==
          canonicalJson(config.toolInputSchema)
        )
          throw callToolFailure('schema_changed');
        if (!prepared.validateInput(args))
          throw callToolFailure('arguments_invalid');
        const result = await session(
          'tools/call',
          { name: tool.name, arguments: args },
          async () => {
            await markDispatch();
            dispatched = true;
          },
        );
        return toolResult(result, prepared.validateOutput);
      } catch (error: unknown) {
        throw exchangeFailure(error, signal, dispatched);
      }
    },
  );
}

function exchangeFailure(
  error: unknown,
  signal: AbortSignal,
  dispatched: boolean,
) {
  if (error instanceof NodeExecutorFailure) return error;
  if (error instanceof McpRpcError)
    return callToolFailure('tool_failed', 'failed', dispatched);
  const code = inspectProviderHttpError(error)?.code;
  if (dispatched) {
    if (code === PROVIDER_HTTP_ERROR_CODE.responseTooLarge)
      return callToolFailure('response_too_large', 'outcome_unknown', true);
    return callToolFailure('invalid_response', 'outcome_unknown', true);
  }
  if (
    code === PROVIDER_HTTP_ERROR_CODE.ssrfBlocked ||
    code === PROVIDER_HTTP_ERROR_CODE.redirectRejected
  )
    return callToolFailure('address_denied');
  if (
    code === PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed ||
    code === PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed ||
    error instanceof ProviderCredentialRejectedError
  )
    return callToolFailure('credential_rejected');
  if (code === PROVIDER_HTTP_ERROR_CODE.responseTooLarge)
    return callToolFailure('response_too_large');
  if (
    code === PROVIDER_HTTP_ERROR_CODE.timedOut ||
    (signal.reason instanceof DOMException &&
      signal.reason.name === 'TimeoutError')
  )
    return callToolFailure('timed_out', 'retry');
  if (signal.aborted)
    return failure('canceled', 'canceled', { possiblyDispatched: false });
  return callToolFailure('invalid_response');
}
