import { readFile } from 'node:fs/promises';

import { CORE_REGISTRY_RELEASE_SUCCESSOR } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  verifyWorkflowExecutableV2,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const identitySchema = z
  .object({ key: z.string().min(1), version: z.number().int().positive() })
  .strict();
const retainedFixtureSchema = z
  .object({
    format: z.literal('pertexo.retained-workflow-v2-fixture'),
    schemaVersion: z.literal(1),
    graph: z.unknown(),
    executable: z.unknown(),
    checksum: z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
    executions: z.array(
      z
        .object({
          nodeId: z.string().min(1),
          definition: identitySchema,
          executor: identitySchema,
          input: z.json(),
          expected: z
            .object({
              kind: z.enum(['succeeded', 'terminal_success']),
              output: z.json(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

async function retainedFixture() {
  const source = await readFile(
    new URL('./fixtures/retained-core-workflow-v2.json', import.meta.url),
    'utf8',
  );
  return retainedFixtureSchema.parse(JSON.parse(source) as unknown);
}

describe('retained core workflow V2 compatibility', () => {
  it('verifies immutable graph, envelope, checksum, and every exact executor pair', async () => {
    const fixture = await retainedFixture();
    const release = composeExecutableCompatibilityRelease(
      CORE_REGISTRY_RELEASE_SUCCESSOR,
    );
    const rebuilt = buildWorkflowExecutableV2({
      graph: fixture.graph,
      release,
    });

    expect(rebuilt).toEqual({
      envelope: fixture.executable,
      checksum: fixture.checksum,
    });
    const verified = verifyWorkflowExecutableV2({
      envelope: fixture.executable,
      checksum: fixture.checksum,
      admissionRelease: release,
    });
    const registry = createCoreNodeRegistry();
    for (const execution of fixture.executions) {
      const pinned = verified.envelope.graph.nodes.find(
        ({ id }) => id === execution.nodeId,
      );
      if (pinned === undefined) throw new Error('retained node pin is missing');
      expect(pinned).toMatchObject({
        definition: execution.definition,
        executor: execution.executor,
      });
      await expect(
        registry.execute({
          config: pinned.config,
          definition: execution.definition,
          executor: execution.executor,
          input: execution.input,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(execution.expected);
    }
  });

  it('fails closed instead of substituting a newer executor version', async () => {
    const fixture = await retainedFixture();
    await expect(
      createCoreNodeRegistry().execute({
        config: {},
        definition: fixture.executions[0]?.definition ?? {
          key: 'core.manual',
          version: 1,
        },
        executor: { key: 'core.manual', version: 2 },
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'executor_not_found' });
  });
});
