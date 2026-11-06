import { expect, it } from 'vitest';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '../../../src/server.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';

it('changes the executable identity when authored mapping order changes', () => {
  const catalog = composeExecutableCatalog(nodeCatalog());
  const draft = structuredClone(graph());
  const node = draft.nodes[1];
  Object.assign(node, {
    inputMappings: {
      name: { kind: 'literal', value: 'Ada' },
      qty: { kind: 'literal', value: 2 },
    },
  });
  const first = buildWorkflowExecutable({ graph: draft, catalog });
  Object.assign(node, {
    inputMappings: {
      qty: { kind: 'literal', value: 2 },
      name: { kind: 'literal', value: 'Ada' },
    },
  });
  const second = buildWorkflowExecutable({ graph: draft, catalog });
  expect(second.checksum).not.toBe(first.checksum);
  expect(() =>
    verifyWorkflowExecutable({
      envelope: second.envelope,
      checksum: first.checksum,
      catalog,
    }),
  ).toThrow();
});

it('binds object order inside literal mappings, config values and callable results', () => {
  const catalog = composeExecutableCatalog(nodeCatalog());
  const checksum = (
    reverse: boolean,
    location: 'mapping' | 'config' | 'result',
  ) => {
    const draft = structuredClone(graph());
    const node = draft.nodes[1];
    const value = reverse ? { qty: 2, name: 'Ada' } : { name: 'Ada', qty: 2 };
    if (location === 'mapping')
      Object.assign(node, {
        inputMappings: { value: { kind: 'literal', value } },
      });
    if (location === 'config') Object.assign(node, { config: { value } });
    return buildWorkflowExecutable({
      graph:
        location === 'result'
          ? {
              ...draft,
              callable: {
                input: { type: 'string' },
                resultType: { type: 'object', properties: [] },
                result: { kind: 'literal', value },
              },
            }
          : draft,
      catalog,
    }).checksum;
  };
  for (const location of ['mapping', 'config', 'result'] as const)
    expect(checksum(true, location)).not.toBe(checksum(false, location));
});
