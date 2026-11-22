import {
  AGENT_TOOL_LIMITS,
  agentTurnOutputSchema,
  inspectJsonValue,
  type JsonValue,
} from '@pertexo/workflow-model';
import type { AgentWorkIdentity } from '../invocations/agent-invocation.js';
import { isJsonRecord, operationError } from '../input-checks/engine-values.js';
import { executableAgentTool } from '../compilation/verified-executable.js';
import type { NodeAttemptInputSource } from './node-attempt.types.js';

export type AgentAttemptInput = Readonly<{
  identity: AgentWorkIdentity;
  history: readonly Readonly<{ proposal: unknown; result: JsonValue }>[];
  proposal?: unknown;
}>;

export function resolveAgentAttemptInput(
  input: Pick<NodeAttemptInputSource, 'agent' | 'executable' | 'nodeId'>,
  mapped: JsonValue,
): JsonValue {
  const pinned = executableAgentTool(input.executable, input.nodeId);
  if (input.agent === undefined || pinned === undefined) return mapped;
  const { identity, history, proposal } = input.agent;
  if (identity.work.kind === 'tool_call') {
    const call = acceptedProposal(proposal);
    if (
      call.name !== pinned.alias ||
      Object.keys(call.arguments).some(
        (field) => !pinned.policy.inputFields.includes(field),
      )
    )
      operationError(
        'attempt_invalid',
        'Agent tool arguments exceed the selected tool policy',
      );
    return pinned.callable === undefined
      ? { ...call.arguments, ...pinned.fixedInput }
      : { input: call.arguments };
  }
  const { inputSchema, policy } = pinned;
  const properties = inputSchema.properties;
  if (!isJsonRecord(properties) || !isJsonRecord(mapped))
    operationError('attempt_invalid', 'Agent tool input schema is missing');
  return {
    ...mapped,
    toolSchema:
      pinned.callable === undefined
        ? {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(properties).filter(([name]) =>
                policy.inputFields.includes(name),
              ),
            ),
            additionalProperties: false,
          }
        : inputSchema,
    history: history.map(({ proposal: saved, result }) => ({
      call: acceptedProposal(saved),
      result: disclosedResult(result, policy.result),
    })),
  };
}

function acceptedProposal(value: unknown) {
  const parsed = agentTurnOutputSchema.safeParse(value);
  if (!parsed.success || !('proposal' in parsed.data))
    operationError('attempt_invalid', 'Agent tool proposal receipt is invalid');
  return parsed.data.proposal;
}

function disclosedResult(
  result: JsonValue,
  disclosure: NonNullable<
    ReturnType<typeof executableAgentTool>
  >['policy']['result'],
): JsonValue {
  const projected =
    disclosure.kind === 'fields' && isJsonRecord(result)
      ? Object.fromEntries(
          Object.entries(result).filter(([field]) =>
            disclosure.fields.includes(field),
          ),
        )
      : result;
  if (inspectJsonValue(projected).bytes <= AGENT_TOOL_LIMITS.resultBytes)
    return projected;
  if (!isJsonRecord(projected) || !Array.isArray(projected.rows))
    return { truncated: true };
  const rows: JsonValue[] = [];
  for (const row of projected.rows as JsonValue[]) {
    if (
      inspectJsonValue({ ...projected, rows: [...rows, row], truncated: true })
        .bytes > AGENT_TOOL_LIMITS.resultBytes
    )
      break;
    rows.push(row);
  }
  return { ...projected, rows, truncated: true };
}
