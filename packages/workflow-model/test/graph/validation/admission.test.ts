import { describe, expect, it } from 'vitest';

import {
  policies,
  graph,
  createOwner,
  required,
} from '../../support/authoring-owner.js';
describe('authoring admission through real compiled workers', () => {
  it('parses without evaluating, exposes safe mapping findings and never changes draft data', async () => {
    const owner = createOwner();
    const input = graph();
    const original = JSON.stringify(input);
    expect(await owner.validate(input, policies)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(JSON.stringify(input)).toBe(original);
    // A valid but expensive execution is only parsed, never run.
    expect(
      await owner.validate(graph('$distinct([1..50000])'), policies),
    ).toMatchObject({ ok: true });
    const invalid = await owner.validate(
      graph('runInput.credential-must-not-leak.'),
      policies,
    );
    expect(invalid).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'invalid_expression',
          path: '$.nodes.step.inputMappings.result',
        },
      ],
    });
    expect(JSON.stringify(invalid)).not.toContain('credential-must-not-leak');
    expect(JSON.stringify(owner.diagnostics())).not.toMatch(
      /expression|config|credential|AST/u,
    );
    expect(await owner.validate(graph('$now()'), policies)).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'This expression uses a construct unavailable in the expression policy.',
        },
      ],
    });
    expect(owner.diagnostics().active).toBe(0);
  });

  it('checks exact definition pins and nested body paths', async () => {
    const owner = createOwner();
    const body = {
      ...graph('runInput.'),
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    };
    const nested = graph();
    const loop = {
      ...required(nested.nodes[0]),
      id: 'loop',
      definition: { key: 'core.foreach', version: 1 },
      inputMappings: {},
      structured: {
        kind: 'for_each',
        maxIterations: 1,
        maxConcurrency: 1,
        body,
      },
    };
    expect(
      await owner.validate({ ...nested, nodes: [loop] }, policies),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          path: '$.nodes.loop.structured.body.nodes.step.inputMappings.result',
        },
      ],
    });
    const noPin = {
      ...policies,
      definitions: [
        { definition: { key: 'core.set', version: 1 }, policyReferences: [] },
      ],
    };
    expect(await owner.validate(graph(), noPin)).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'The expression policy is not available for this step definition.',
        },
      ],
    });
    const futurePin = {
      ...noPin,
      definitions: [
        {
          definition: { key: 'core.set', version: 1 },
          policyReferences: [{ key: 'other.policy', version: 1 }],
        },
      ],
    };
    const futureNode = required(graph().nodes[0]);
    expect(
      await owner.validate(
        {
          ...graph(),
          nodes: [
            {
              ...futureNode,
              inputMappings: {
                result: {
                  ...futureNode.inputMappings.result,
                },
              },
            },
          ],
        },
        futurePin,
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'The expression policy is not available for this step definition.',
        },
      ],
    });
    await expect(
      owner.validate(graph(), {
        ...policies,
        definitions: [
          required(policies.definitions[0]),
          required(policies.definitions[0]),
        ],
      }),
    ).rejects.toMatchObject({ reason: 'invalid_policy_projection' });
  });

  it('retains existing exact/over language limits and the public graph envelope', async () => {
    const owner = createOwner();
    for (const source of [
      '1' + ' '.repeat(16_383),
      Array(64).fill('1').join('+'),
      '[' + Array(2047).fill('1').join(',') + ']',
    ])
      expect(await owner.validate(graph(source), policies)).toMatchObject({
        ok: true,
      });
    for (const source of [
      '1' + ' '.repeat(16_384),
      Array(65).fill('1').join('+'),
      '[' + Array(2048).fill('1').join(',') + ']',
    ])
      expect(await owner.validate(graph(source), policies)).toMatchObject({
        ok: false,
        issues: [{ code: 'invalid_expression' }],
      });
    const many = graph();
    required(many.nodes[0]).inputMappings = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        'f' + String(i),
        {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.v + ' + String(i),
        },
      ]),
    ) as (typeof many.nodes)[0]['inputMappings'];
    expect(await owner.validate(many, policies)).toMatchObject({ ok: true });
    await expect(
      owner.validate(
        { ...graph(), settings: { secret: 'x'.repeat(1_048_576) } },
        policies,
      ),
    ).rejects.toBeTruthy();
  });
});
