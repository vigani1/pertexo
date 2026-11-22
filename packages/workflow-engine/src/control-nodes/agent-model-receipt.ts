import { agentTurnOutputSchema, type JsonValue } from '@pertexo/workflow-model';
import { isJsonRecord, operationError } from '../input-checks/engine-values.js';
import type { AgentAttemptReceipt } from './agent-continuation.js';

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
  const parsed = agentTurnOutputSchema.safeParse(record?.value);
  if (!parsed.success)
    operationError('observation_invalid', 'Agent model receipt is invalid');
  const reported =
    typeof record?.inputTokens === 'number' &&
    typeof record.outputTokens === 'number'
      ? { inputTokens: record.inputTokens, outputTokens: record.outputTokens }
      : undefined;
  return 'proposal' in parsed.data
    ? {
        kind: 'proposal' as const,
        call: parsed.data.proposal,
        output,
        usage: reported,
      }
    : { kind: 'final' as const, value: parsed.data, output, usage: reported };
}
