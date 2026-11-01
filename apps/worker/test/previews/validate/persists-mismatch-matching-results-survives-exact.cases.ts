import { parseStoredExecutionValue } from '@pertexo/core/runs';

import {
  CORE_VALIDATE_CONFIG_SCHEMA,
  evaluateCoreValidate,
} from '@pertexo/nodes-core';

import { expect, it } from 'vitest';

import {
  acceptDelivery,
  providerEffectCount,
  validTraceparent,
  waitFor,
  withPublishedPreviewDelivery,
} from '../../support/previews/consumer.js';
import { validateConfigInput, createValidateRuntime } from './fixture.js';

export function registerPersistsMismatchMatchingResultsSurvivesExact(): void {
  it('persists mismatch and matching results and survives exact redelivery after restart', async () => {
    const config = CORE_VALIDATE_CONFIG_SCHEMA.parse(validateConfigInput);
    const runInput = {
      profile: { email: 'bad', role: 'member' },
      secret: 'must-not-be-echoed',
    };
    const resolvedInput = {
      profile: runInput.profile,
      secret: runInput.secret,
    };
    const expected = evaluateCoreValidate(config, resolvedInput);
    const traceparent = validTraceparent;
    const delivery = await acceptDelivery(traceparent, {
      definitionKey: 'core.validate',
      definitionVersion: 1,
      executableNode: {
        config: validateConfigInput,
        configVersion: 1,
        definition: { key: 'core.validate', version: 1 },
        id: 'validate-node',
        inputMappings: {
          profile: { kind: 'run_input', path: '$.profile' },
          secret: { kind: 'run_input', path: '$.secret' },
        },
        connectionRefs: {},
      },
      executorKey: 'core.validate',
      executorVersion: 1,
      input: { kind: 'manual', value: runInput },
      nodeId: 'validate-node',
      scope: 'validate-preview',
    });
    expect(resolvedInput.secret).toBe(runInput.secret);
    const validateRuntime = await createValidateRuntime();
    const { runtime } = validateRuntime;
    try {
      const mismatchState = await withPublishedPreviewDelivery(
        runtime,
        delivery,
        async ({ job, queue, state }) => {
          expect(state?.dispatch_marked_at).toBeNull();
          const persisted = parseStoredExecutionValue(state?.output_ref);
          expect(persisted).toEqual({
            kind: 'inline',
            value: expected,
          });
          if (persisted.kind !== 'inline')
            throw new Error('Validate mismatch output is not inline');
          expect(persisted.value).toMatchObject({
            issues: [
              {
                code: 'min_length',
                path: '$.profile.email',
                ruleId: 'email',
              },
              { code: 'enum', path: '$.profile.role', ruleId: 'role' },
            ],
            valid: false,
          });
          expect(JSON.stringify(persisted)).not.toContain(runInput.secret);
          await expect(providerEffectCount('validate-preview')).resolves.toBe(
            0,
          );
          expect(validateRuntime.resolveConnection).not.toHaveBeenCalled();
          expect(validateRuntime.writeArtifact).not.toHaveBeenCalled();
          const completedJob = await waitFor(
            () => queue.getJob(job.jobId),
            (value) => value !== undefined,
          );
          if (completedJob === undefined)
            throw new Error('completed validate preview job missing');
          await waitFor(
            () => completedJob.getState(),
            (value) => value === 'completed',
          );
          await completedJob.remove();
          return state;
        },
      );
      await runtime.close();

      // The next process instance receives the exact same transport envelope;
      // durable claim state must classify it as a duplicate without changing
      // the result or calling a capability factory.
      const restarted = await createValidateRuntime();
      const restartedRuntime = restarted.runtime;
      try {
        await withPublishedPreviewDelivery(
          restartedRuntime,
          delivery,
          ({ state }) => {
            expect(state).toEqual(mismatchState);
            return Promise.resolve();
          },
        );

        const matchingInput = {
          profile: {
            email: 'valid@example.test',
            role: 'admin',
          },
          secret: 'matching-secret-must-not-be-echoed',
        };
        const matchingExpected = evaluateCoreValidate(config, {
          profile: matchingInput.profile,
          secret: matchingInput.secret,
        });
        const matchingDelivery = await acceptDelivery(validTraceparent, {
          definitionKey: 'core.validate',
          definitionVersion: 1,
          executableNode: {
            config: validateConfigInput,
            configVersion: 1,
            definition: { key: 'core.validate', version: 1 },
            id: 'validate-node',
            inputMappings: {
              profile: { kind: 'run_input', path: '$.profile' },
              secret: { kind: 'run_input', path: '$.secret' },
            },
            connectionRefs: {},
          },
          executorKey: 'core.validate',
          executorVersion: 1,
          input: { kind: 'manual', value: matchingInput },
          nodeId: 'validate-node',
          scope: 'validate-preview-matching',
        });
        await withPublishedPreviewDelivery(
          restartedRuntime,
          matchingDelivery,
          ({ state }) => {
            const persisted = parseStoredExecutionValue(state?.output_ref);
            expect(persisted).toEqual({
              kind: 'inline',
              value: matchingExpected,
            });
            if (persisted.kind !== 'inline')
              throw new Error('Validate matching output is not inline');
            expect(matchingExpected.valid).toBe(true);
            expect(persisted.value).toMatchObject({ issues: [], valid: true });
            expect(JSON.stringify(persisted)).not.toContain(
              matchingInput.secret,
            );
            return Promise.resolve();
          },
        );
        expect(restarted.resolveConnection).not.toHaveBeenCalled();
        expect(restarted.writeArtifact).not.toHaveBeenCalled();
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      await runtime.close();
    }
  });
}
