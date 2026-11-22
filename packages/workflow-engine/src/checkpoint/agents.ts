import {
  AGENT_LIMITS,
  compareOrdinal,
  isRecord,
  isSafeExecutorErrorCode,
} from '@pertexo/workflow-model';
import type {
  AgentContinuation,
  AgentToolExchange,
} from '../control-nodes/agent-continuation.js';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import type { InvocationState } from '../workflow-execution.js';
import { assertCheckpoint, assertExactKeys, isInteger } from './admission.js';
import { parseOutputReference } from './fields.js';
import { assertCanonicalTimestamp } from './identity.js';

export function parseAgents(
  value: unknown,
  invocationByKey: ReadonlyMap<string, InvocationState>,
): readonly AgentContinuation[] {
  assertCheckpoint(
    Array.isArray(value),
    'Agent continuations must be an array',
  );
  const agents = value.map(parseAgent);
  const keys = new Set<string>();
  for (const { parentInvocationKey } of agents) {
    assertCheckpoint(
      invocationByKey.has(parentInvocationKey),
      'Agent parent invocation is missing',
    );
    assertCheckpoint(
      !keys.has(parentInvocationKey),
      'Agent continuation keys must be unique',
    );
    keys.add(parentInvocationKey);
  }
  return agents.sort((left, right) =>
    compareOrdinal(left.parentInvocationKey, right.parentInvocationKey),
  );
}

function parseAgent(value: unknown): AgentContinuation {
  assertCheckpoint(isRecord(value), 'Agent continuation must be an object');
  assertExactKeys(
    value,
    [
      'parentInvocationKey',
      'deadlineAt',
      'modelRates',
      'budget',
      'turn',
      'phase',
    ],
    ['history'],
  );
  const { parentInvocationKey, modelRates, budget, history } = value;
  assertCheckpoint(
    typeof parentInvocationKey === 'string' &&
      parentInvocationKey.length > 0 &&
      parentInvocationKey.length <=
        WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength,
    'Agent parent invocation key is invalid',
  );
  assertCheckpoint(isRecord(modelRates), 'Agent model rates are invalid');
  assertExactKeys(modelRates, ['input', 'output']);
  assertCheckpoint(isRecord(budget), 'Agent budget is invalid');
  assertExactKeys(budget, [
    'dispatches',
    'inputTokens',
    'outputTokens',
    'estimatedCost',
  ]);
  return {
    parentInvocationKey,
    deadlineAt: assertCanonicalTimestamp(value.deadlineAt, 'Agent deadline'),
    modelRates: {
      input: boundedInteger(modelRates.input, 0, AGENT_LIMITS.costNanoDollars),
      output: boundedInteger(
        modelRates.output,
        0,
        AGENT_LIMITS.costNanoDollars,
      ),
    },
    budget: {
      dispatches: boundedInteger(
        budget.dispatches,
        0,
        AGENT_LIMITS.modelDispatches,
      ),
      inputTokens: boundedInteger(
        budget.inputTokens,
        0,
        AGENT_LIMITS.inputTokens,
      ),
      outputTokens: boundedInteger(
        budget.outputTokens,
        0,
        AGENT_LIMITS.outputTokens,
      ),
      estimatedCost: boundedInteger(
        budget.estimatedCost,
        0,
        AGENT_LIMITS.costNanoDollars,
      ),
    },
    turn: boundedInteger(value.turn, 1, AGENT_LIMITS.turns),
    phase: parsePhase(value.phase),
    ...(history === undefined ? {} : { history: parseHistory(history) }),
  };
}

function parseHistory(value: unknown) {
  assertCheckpoint(
    Array.isArray(value) && value.length <= AGENT_LIMITS.toolCalls,
    'Agent tool history exceeds its bound',
  );
  return value.map((exchange: unknown): AgentToolExchange => {
    assertCheckpoint(
      isRecord(exchange),
      'Agent tool exchange must be an object',
    );
    const proposal = attemptReceipt(exchange.proposal, 'Agent proposal');
    if ('outcome' in exchange) {
      assertExactKeys(exchange, ['proposal', 'outcome']);
      const { outcome } = exchange;
      assertCheckpoint(
        outcome === 'rejected' || outcome === 'expired',
        'Agent approval outcome is invalid',
      );
      return { proposal, outcome };
    }
    if ('child' in exchange) {
      assertExactKeys(exchange, ['proposal', 'child']);
      const child = parseOutputReference(exchange.child, 'Agent child result');
      assertCheckpoint(
        child.kind === 'call',
        'Agent child must reference a Call result',
      );
      return { proposal, child };
    }
    if ('childFailure' in exchange) {
      assertExactKeys(exchange, ['proposal', 'childFailure']);
      const { childFailure } = exchange;
      assertCheckpoint(
        typeof childFailure === 'string' &&
          isSafeExecutorErrorCode(childFailure),
        'Agent child failure code is invalid',
      );
      return { proposal, childFailure };
    }
    assertExactKeys(exchange, ['proposal', 'output']);
    return {
      proposal,
      output: attemptReceipt(exchange.output, 'Agent tool output'),
    };
  });
}

function parsePhase(value: unknown): AgentContinuation['phase'] {
  assertCheckpoint(isRecord(value), 'Agent phase must be an object');
  const { kind } = value;
  switch (kind) {
    case 'model_turn':
      assertExactKeys(value, ['kind']);
      return { kind };
    case 'completion':
      assertExactKeys(value, ['kind', 'output']);
      return { kind, output: attemptReceipt(value.output, 'Agent output') };
    case 'proposed_call':
    case 'running_tool':
      assertExactKeys(value, ['kind', 'ordinal', 'proposal']);
      return { kind, ...toolCall(value) };
    case 'approval_wait': {
      assertExactKeys(value, ['kind', 'ordinal', 'proposal'], ['task']);
      if (value.task === undefined) return { kind, ...toolCall(value) };
      const task = parseOutputReference(value.task, 'Agent approval');
      assertCheckpoint(
        task.kind === 'task',
        'Agent approval must reference a task',
      );
      return { kind, ...toolCall(value), task };
    }
    default:
      assertCheckpoint(false, 'Agent phase is invalid');
  }
}

function toolCall(value: Record<string, unknown>) {
  return {
    ordinal: boundedInteger(value.ordinal, 1, AGENT_LIMITS.toolCalls),
    proposal: attemptReceipt(value.proposal, 'Agent proposal'),
  };
}

function attemptReceipt(value: unknown, label: string) {
  const reference = parseOutputReference(value, label);
  assertCheckpoint(
    reference.kind === 'inline',
    `${label} must reference an attempt receipt`,
  );
  return reference;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  assertCheckpoint(
    isInteger(value) && value >= minimum && value <= maximum,
    'Agent ordinal, rate or budget is outside its bounds',
  );
  return value;
}
