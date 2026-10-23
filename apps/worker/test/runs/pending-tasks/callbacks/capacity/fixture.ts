import {
  callbackWaitConfigSchema,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { callbackTokenHash } from '@pertexo/integrations/server';
import { node } from '../../../calls/fixtures.js';
import type { callbackResources } from '../fixtures.js';

export const wait = (id: string) => ({
  ...node(id, 'core.wait'),
  config: callbackWaitConfigSchema.parse({
    mode: 'callback',
    timeoutSeconds: 60,
  }),
});

export async function reply(
  resources: ReturnType<typeof callbackResources>,
  id: string,
) {
  const signal = AbortSignal.timeout(5_000);
  const callback = await resources.store.resolve(
    callbackTokenHash(resources.keys.material({ id }, '1').token),
    signal,
  );
  if (callback === null) throw new Error('Missing callback');
  await resources.store.respond({
    callback,
    output: { body: { value: 'resumed' }, headers: {} },
    redactOutput: (text) => text,
    signal,
  });
}

export function loop(id: string, body: WorkflowNode): WorkflowNode {
  return {
    ...node(id, 'core.foreach'),
    inputMappings: { items: { kind: 'literal', value: [1, 2] } },
    structured: {
      kind: 'for_each',
      maxIterations: 2,
      maxConcurrency: 2,
      body: {
        settings: {},
        nodes: [body],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}
