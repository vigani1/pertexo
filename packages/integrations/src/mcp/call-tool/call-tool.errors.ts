import {
  NodeExecutorFailure,
  type NodeExecutorErrorKind,
} from '@pertexo/node-sdk/server';

const errors = {
  credential_rejected: 'authentication',
  address_denied: 'configuration',
  schema_changed: 'configuration',
  schema_unsupported: 'configuration',
  arguments_invalid: 'configuration',
  invalid_response: 'provider',
  response_too_large: 'provider',
  tool_failed: 'provider',
  unavailable: 'provider',
  timed_out: 'timeout',
} as const satisfies Record<string, NodeExecutorErrorKind>;

type McpFailure = keyof typeof errors;
export const MCP_FAILURE_CODES = Object.keys(errors).map(
  (code) => `mcp.${code}`,
);

export function callToolFailure(
  code: McpFailure,
  kind: 'failed' | 'retry' | 'outcome_unknown' = 'failed',
  possiblyDispatched = false,
) {
  return new NodeExecutorFailure({
    kind,
    errorKind: errors[code],
    possiblyDispatched,
    safeErrorCode: `mcp.${code}`,
  });
}
