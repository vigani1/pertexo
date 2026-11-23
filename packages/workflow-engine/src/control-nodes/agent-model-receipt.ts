import {
  type AgentToolCall,
  agentTurnOutputSchema,
  type JsonValue,
} from '@pertexo/workflow-model';
import { isJsonRecord, operationError } from '../input-checks/engine-values.js';
import { hasExactFields } from '../input-checks/exact-fields.js';
import { settleAgentModelTurn } from './settle-agent-work.js';
import { settleAgentTurnUsage } from './agent-budget.js';
import type {
  AgentAttemptReceipt,
  AgentContinuation,
} from './agent-continuation.js';

export function readAgentModelReceipt(
  outputs: readonly JsonValue[],
  invocationKey: string,
  output: AgentAttemptReceipt,
) {
  const material = outputs.find(
    (item) =>
      isJsonRecord(item) &&
      item.attemptId === output.attemptId &&
      item.invocationKey === invocationKey,
  );
  const record = isJsonRecord(material) ? material : undefined;
  const parsed = parseStoredAgentTurn(record?.value);
  if (parsed === undefined)
    operationError('observation_invalid', 'Agent model receipt is invalid');
  const reported =
    typeof record?.inputTokens === 'number' &&
    typeof record.outputTokens === 'number'
      ? { inputTokens: record.inputTokens, outputTokens: record.outputTokens }
      : undefined;
  return 'proposal' in parsed
    ? {
        kind: 'proposal' as const,
        call: parsed.proposal,
        admission: parsed.admission,
        output,
        usage: reported,
      }
    : { kind: 'final' as const, value: parsed, output, usage: reported };
}

type Admission =
  | Readonly<{ kind: 'accepted'; input: JsonValue }>
  | Readonly<{ kind: 'refused' }>;
type StoredAgentTurn =
  | Readonly<{ text: string }>
  | Readonly<{ proposal: AgentToolCall; admission?: Admission }>;

/** A legacy receipt has only the model output; new proposals also retain input admission. */
export function parseStoredAgentTurn(
  value: unknown,
): StoredAgentTurn | undefined {
  if (!isJsonRecord(value) || value.admission === undefined)
    return agentTurnOutputSchema.safeParse(value).data;
  const { admission, ...output } = value;
  if (!isJsonRecord(admission)) return undefined;
  const parsed = agentTurnOutputSchema.safeParse(output).data;
  if (parsed === undefined || !('proposal' in parsed)) return undefined;
  if (admission.kind === 'refused' && hasExactFields(admission, ['kind']))
    return { ...parsed, admission: { kind: 'refused' } };
  if (
    admission.kind === 'accepted' &&
    hasExactFields(admission, ['kind', 'input']) &&
    admission.input !== undefined
  )
    return {
      ...parsed,
      admission: { kind: 'accepted', input: admission.input },
    };
  return undefined;
}

export function settleModelReceipt(
  agent: AgentContinuation,
  receipt: ReturnType<typeof readAgentModelReceipt>,
  alias: string,
) {
  const usage = settleAgentTurnUsage(agent, receipt.usage);
  if (usage.kind === 'refused') return usage;
  return settleAgentModelTurn(
    { ...agent, budget: usage.budget },
    receipt,
    alias,
  );
}
