import {
  AGENT_TOOL_LIMITS,
  validateCallableValue,
  inspectJsonValue,
  type JsonValue,
} from '@pertexo/workflow-model';
import type { DefinitionIdentity } from '@pertexo/node-sdk';
import { parseStoredAgentTurn } from '../control-nodes/agent-model-receipt.js';
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
): Readonly<{ value: JsonValue; admitted?: true }> {
  const pinned = executableAgentTool(input.executable, input.nodeId);
  if (input.agent === undefined || pinned === undefined)
    return { value: mapped };
  const { identity, history, proposal } = input.agent;
  if (identity.work.kind === 'tool_call') {
    const { proposal: call, admission } = acceptedProposal(proposal);
    if (admission?.kind === 'accepted')
      return { value: admission.input, admitted: true };
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
    return { value: toolInput(pinned, call.arguments) };
  }
  const { inputSchema, policy } = pinned;
  const properties = inputSchema.properties;
  if (!isJsonRecord(properties) || !isJsonRecord(mapped))
    operationError('attempt_invalid', 'Agent tool input schema is missing');
  return {
    value: {
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
        call: acceptedProposal(saved).proposal,
        result: disclosedResult(result, policy.result),
      })),
    },
  };
}

function acceptedProposal(value: unknown) {
  const parsed = parseStoredAgentTurn(value);
  if (parsed === undefined || !('proposal' in parsed))
    operationError('attempt_invalid', 'Agent tool proposal receipt is invalid');
  return {
    proposal: parsed.proposal,
    admission: parsed.admission,
  };
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
  const truncated = { ...projected, rows, truncated: true };
  return inspectJsonValue(truncated).bytes <= AGENT_TOOL_LIMITS.resultBytes
    ? truncated
    : { truncated: true };
}

type AgentTool = NonNullable<ReturnType<typeof executableAgentTool>>;
export type AdmitAgentToolInput = (
  definition: DefinitionIdentity,
  value: JsonValue,
) => JsonValue | undefined;

export function withAgentProposalAdmission(
  input: Pick<NodeAttemptInputSource, 'agent' | 'executable' | 'nodeId'>,
  output: JsonValue,
  admit: AdmitAgentToolInput,
): JsonValue {
  if (
    input.agent?.identity.work.kind !== 'model_turn' ||
    !isJsonRecord(output) ||
    output.proposal === undefined
  )
    return output;
  const { proposal } = acceptedProposal(output);
  const tool = executableAgentTool(input.executable, input.nodeId);
  const allowed =
    tool?.alias === proposal.name &&
    Object.keys(proposal.arguments).every((field) =>
      tool.policy.inputFields.includes(field),
    ) &&
    (tool.callable === undefined ||
      validateCallableValue(tool.callable.input, proposal.arguments) ===
        undefined);
  const admitted = allowed
    ? admit(tool.node.definition, toolInput(tool, proposal.arguments))
    : undefined;
  return {
    proposal,
    admission:
      admitted === undefined
        ? { kind: 'refused' }
        : { kind: 'accepted', input: admitted },
  };
}

function toolInput(
  tool: AgentTool,
  args: Readonly<Record<string, JsonValue>>,
): JsonValue {
  return tool.callable === undefined
    ? { ...args, ...tool.fixedInput }
    : { input: args };
}
