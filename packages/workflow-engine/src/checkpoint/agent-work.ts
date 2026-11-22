import { AGENT_LIMITS, isRecord } from '@pertexo/workflow-model';

import type { AgentWorkIdentity } from '../invocations/agent-invocation.js';
import { assertCheckpoint, assertExactKeys, isInteger } from './admission.js';

export function parseAgentWorkIdentity(value: unknown): AgentWorkIdentity {
  assertCheckpoint(isRecord(value), 'Agent work must be an object');
  assertExactKeys(value, ['parentInvocationKey', 'turn', 'work']);
  const { parentInvocationKey, turn, work } = value;
  assertCheckpoint(
    typeof parentInvocationKey === 'string' && parentInvocationKey.length > 0,
    'Agent work requires a parent invocation key',
  );
  assertCheckpoint(
    isInteger(turn) && turn > 0 && turn <= AGENT_LIMITS.turns,
    'Agent work turn is invalid',
  );
  assertCheckpoint(isRecord(work), 'Agent work kind is invalid');
  if (work.kind === 'model_turn') {
    assertExactKeys(work, ['kind']);
    return { parentInvocationKey, turn, work: { kind: work.kind } };
  }
  assertCheckpoint(work.kind === 'tool_call', 'Agent work kind is invalid');
  assertExactKeys(work, ['kind', 'ordinal']);
  const { ordinal } = work;
  assertCheckpoint(
    isInteger(ordinal) && ordinal > 0 && ordinal <= AGENT_LIMITS.toolCalls,
    'Agent tool ordinal is invalid',
  );
  return { parentInvocationKey, turn, work: { kind: work.kind, ordinal } };
}
