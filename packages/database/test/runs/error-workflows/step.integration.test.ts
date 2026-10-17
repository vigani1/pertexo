import { expect, it } from 'vitest';
import { apiPool } from '../../support/workflow-authoring.js';
import { workflowGraphStepSql } from '../../../src/runs/queries/execution/graph-step.js';

it('reads only declared steps, including structured bodies, without interpreting configuration as metadata', async () => {
  const decoy = {
    id: 'nested',
    label: 'sensitive-password',
    definition: { key: 'private-data' },
  };
  const graph = {
    nodes: [
      {
        id: 'first',
        label: 'First published step',
        definition: { key: 'core.set' },
        config: { payload: decoy },
      },
      {
        id: 'loop',
        definition: { key: 'core.foreach' },
        structured: {
          body: {
            nodes: [
              {
                id: 'nested',
                label: 'Nested published step',
                definition: { key: 'http.request' },
                inputMappings: {
                  data: { kind: 'literal', value: { ...decoy, id: 'absent' } },
                },
              },
            ],
          },
        },
      },
    ],
  };
  for (const [id, expected] of [
    ['first', [{ name: 'First published step', type: 'core.set' }]],
    ['nested', [{ name: 'Nested published step', type: 'http.request' }]],
    ['absent', []],
  ] as const) {
    const found = await apiPool.query<{ name: string; type: string }>(
      `select value->>'label' name,value->'definition'->>'key' type from (${workflowGraphStepSql('$1::jsonb', '$2::text')}) metadata`,
      [JSON.stringify(graph), id],
    );
    expect(found.rows).toEqual(expected);
    expect(JSON.stringify(found.rows)).not.toContain('sensitive-password');
  }
});
