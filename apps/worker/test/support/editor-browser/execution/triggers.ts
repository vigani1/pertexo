import { randomUUID } from 'node:crypto';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { maintenanceConfig } from '../../../../../../infrastructure/testing/worker-databases.mjs';

import {
  createTriggerRuntime,
  type TriggerRuntime,
} from '../../../../src/triggers/trigger.runtime.js';
import type {
  EditorWorkerCapabilities,
  EditorWorkerExecution,
} from './editor-execution.types.js';
import {
  controlledHttp,
  curatedTemplates,
  errorWorkflowCase,
  pollingCase,
  scheduleCase,
  webhookResponseCase,
} from './environment.js';

export async function startEditorTriggers(
  { database, resources, namespace, assertSetupActive }: EditorWorkerExecution,
  controlledCapabilities: EditorWorkerCapabilities | undefined,
) {
  const providerConnections = controlledCapabilities?.factories.connections;
  const triggers: TriggerRuntime[] = [];
  resources.triggers = triggers;
  if (
    scheduleCase ||
    pollingCase ||
    controlledHttp ||
    curatedTemplates ||
    errorWorkflowCase ||
    webhookResponseCase
  ) {
    for (const scanner of scheduleCase ? ['one', 'two'] : ['webhook']) {
      const trigger = await createTriggerRuntime({
        maintenanceDatabase: maintenanceConfig(database),
        database,
        redisUrl: namespace.redisUrl,
        batchSize: 10,
        leaseDurationSeconds: 5,
        leaseOwner: `editor-schedule-${scanner}:${randomUUID()}`,
        onTimeWindowSeconds: 300,
        pollIntervalMillis: 250,
        ...(providerConnections === undefined ? {} : { providerConnections }),
        ...(pollingCase
          ? {
              httpRequest: {
                allowedPrivateNetworks:
                  parseAllowedPrivateNetworks('127.0.0.1/32'),
              },
            }
          : {}),
      });
      triggers.push(trigger);
      assertSetupActive();
    }
  }
  return triggers;
}
