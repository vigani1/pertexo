import { compareOrdinal } from '@pertexo/workflow-model';
import {
  DATABASE_MODULE,
  EMAIL_MODULE,
  HTTP_MODULE,
  SLACK_MODULE,
  type IntegrationExecutorDependencies,
  type IntegrationModule,
  type IntegrationPresentation,
} from '@pertexo/integrations/server';
import { IntegrationRegistryError } from './node-catalog.errors.js';

const modules = [
  HTTP_MODULE,
  SLACK_MODULE,
  DATABASE_MODULE,
  EMAIL_MODULE,
] satisfies readonly IntegrationModule[];

export function registerIntegrationModules(
  modules: readonly IntegrationModule[],
) {
  const moduleKeys = new Set<string>();
  const stepOwners = new Map<string, string>();
  const presentations = new Map<string, IntegrationPresentation>();
  const entries = modules.flatMap((module) => {
    if (moduleKeys.has(module.key))
      throw new IntegrationRegistryError('module', module.key);
    moduleKeys.add(module.key);
    return module.steps.map(
      ({ registration, presentation, createExecutor }) => {
        const { key, version } = registration.manifest.definition;
        const identity = `${key}@${String(version)}`;
        const owner = stepOwners.get(key);
        if (
          (owner !== undefined && owner !== module.key) ||
          presentations.has(identity)
        )
          throw new IntegrationRegistryError('step', key);
        stepOwners.set(key, module.key);
        presentations.set(
          identity,
          Object.freeze({
            ...module.presentation,
            name:
              registration.manifest.display?.name ?? module.presentation.name,
            ...presentation,
          }),
        );
        return { registration, createExecutor };
      },
    );
  });
  // Polling triggers precede integration actions in the published catalog.
  const triggers = entries.filter(
    ({ registration: { manifest } }) => manifest.family === 'trigger',
  );
  triggers.sort((left, right) =>
    compareOrdinal(
      left.registration.manifest.definition.key,
      right.registration.manifest.definition.key,
    ),
  );
  const orderedSteps = [
    ...triggers,
    ...entries.filter(
      ({ registration: { manifest } }) => manifest.family !== 'trigger',
    ),
  ];
  return {
    registrations: orderedSteps.map(({ registration }) => registration),
    createExecutors: (dependencies: IntegrationExecutorDependencies) =>
      orderedSteps.map(({ createExecutor }) => createExecutor(dependencies)),
    policies: modules.flatMap(({ policies }) => policies ?? []),
    presentationFor: ({ key, version }: { key: string; version: number }) =>
      presentations.get(`${key}@${String(version)}`),
  };
}

export const INTEGRATION_MODULE_REGISTRY = registerIntegrationModules(modules);
