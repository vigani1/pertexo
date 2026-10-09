import type {
  NodeDefinitionRegistration,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { coreConditionExecutor } from './condition/executor.js';
import { CORE_NODE_DEFINITION_REGISTRATIONS } from './definitions.js';
import { coreForEachExecutor } from './for-each/executor.js';
import { coreManualExecutor } from './manual/executor.js';
import { coreMergeExecutor } from './merge/executor.js';
import { coreParallelExecutor } from './parallel/executor.js';
import { coreScheduleExecutor } from './schedule/executor.js';
import { coreSetExecutor } from './set/executor.js';
import { coreSwitchExecutor } from './switch/executor.js';
import { coreTerminateExecutor } from './terminate/executor.js';
import { coreWaitExecutor } from './wait/executor.js';
import { coreWebhookExecutor } from './webhook/executor.js';
import { coreValidateExecutor } from './validate/executor.js';

interface CoreNodeRegistrationBundle {
  readonly definition: NodeDefinitionRegistration;
  readonly executor: NodeExecutorRegistration;
}

function identityToken(identity: Readonly<{ key: string; version: number }>) {
  return `${identity.key}\u0000${String(identity.version)}`;
}

function createCoreNodeRegistrationBundles(
  definitions: readonly NodeDefinitionRegistration[],
  executors: readonly NodeExecutorRegistration[],
): readonly CoreNodeRegistrationBundle[] {
  const executorsByIdentity = new Map<string, NodeExecutorRegistration>();
  for (const executor of executors) {
    const token = identityToken(executor.executor);
    if (executorsByIdentity.has(token))
      throw new Error(
        'Core node executor identity is registered more than once',
      );
    executorsByIdentity.set(token, executor);
  }

  const bundles = definitions.map((definition) => {
    const token = identityToken(definition.manifest.executor);
    const executor = executorsByIdentity.get(token);
    if (executor === undefined)
      throw new Error('Core node definition has no matching executor');
    executorsByIdentity.delete(token);
    return Object.freeze({ definition, executor });
  });
  if (executorsByIdentity.size !== 0)
    throw new Error('Core node executor has no matching definition');
  return Object.freeze(bundles);
}

const CORE_NODE_EXECUTOR_IMPLEMENTATIONS = Object.freeze([
  coreConditionExecutor,
  coreForEachExecutor,
  coreManualExecutor,
  coreMergeExecutor,
  coreParallelExecutor,
  coreScheduleExecutor,
  coreSetExecutor,
  coreSwitchExecutor,
  coreTerminateExecutor,
  coreWaitExecutor,
  coreWebhookExecutor,
  coreValidateExecutor,
] as const);

const CORE_NODE_REGISTRATION_BUNDLES = createCoreNodeRegistrationBundles(
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_EXECUTOR_IMPLEMENTATIONS,
);

export const CORE_NODE_EXECUTOR_REGISTRATIONS = Object.freeze(
  CORE_NODE_REGISTRATION_BUNDLES.map(({ executor }) => executor),
);
