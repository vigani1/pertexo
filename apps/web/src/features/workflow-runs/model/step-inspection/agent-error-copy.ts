import type { StepErrorCopy } from './error-copy';

const reduceWork =
  'Use a shorter task or ask for fewer rows, then publish and replay.';

export const AGENT_STEP_ERRORS = {
  'agent.accounting': {
    sentence:
      'The Agent could not verify the model’s usage against its budget.',
    advice:
      'Check the configured model rates and provider usage reporting before replaying.',
  },
  'agent.cost_limit': {
    sentence: 'The Agent reached its estimated model cost limit.',
    advice: reduceWork,
  },
  'agent.deadline': {
    sentence: 'The Agent ran out of time.',
    advice: reduceWork,
  },
  'agent.dispatch_limit': {
    sentence:
      'The Agent reached its limit on model requests, including retries.',
    advice: reduceWork,
  },
  'agent.token_limit': {
    sentence: 'The Agent reached its total token limit.',
    advice: reduceWork,
  },
  'agent.tool_limit': {
    sentence: 'The Agent reached its tool call limit.',
    advice: reduceWork,
  },
  'agent.turn_limit': {
    sentence: 'The Agent reached its model turn limit.',
    advice: reduceWork,
  },
  'agent.tool_unavailable': {
    sentence: 'The model requested a tool outside this Agent’s setup.',
    advice: 'Check the tool alias and description before replaying.',
  },
  'agent.stale_receipt': {
    sentence: 'The Agent could not match a result to the current turn.',
    advice: 'Review the Agent activity before replaying.',
  },
  'agent.child_failed': {
    sentence: 'A model turn or tool call did not finish successfully.',
    advice: 'Open the failed item in Agent activity for its attempt history.',
  },
} satisfies Readonly<Record<string, StepErrorCopy>>;
