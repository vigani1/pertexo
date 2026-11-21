export function logicalNodeFact(fact: {
  attempt_status: string;
  node_id: string;
  node_status: string;
  output_ref: unknown;
}) {
  return {
    attempt_status: fact.attempt_status,
    node_id: fact.node_id,
    node_status: fact.node_status,
    output_ref: fact.output_ref,
  };
}

export const linearNodeFacts = [
  {
    attempt_status: 'succeeded',
    node_id: 'manual',
    node_status: 'succeeded',
    output_ref: {
      kind: 'inline',
      value: { name: 'Ada' },
    },
  },
  {
    attempt_status: 'succeeded',
    node_id: 'set',
    node_status: 'succeeded',
    output_ref: {
      kind: 'inline',
      value: {
        fromRun: 'Ada',
        literal: 1,
      },
    },
  },
  {
    attempt_status: 'succeeded',
    node_id: 'terminate',
    node_status: 'succeeded',
    output_ref: {
      kind: 'inline',
      value: {
        result: {
          fromRun: 'Ada',
          literal: 1,
        },
      },
    },
  },
];
