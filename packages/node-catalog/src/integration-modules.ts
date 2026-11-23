import { generateSchemaDocument } from '@pertexo/node-sdk';
import { compareOrdinal, isRecord } from '@pertexo/workflow-model';
import {
  INTEGRATION_MODULES,
  type ConnectionDefinition,
  type ConnectionLookup,
  type IntegrationExecutorDependencies,
  type IntegrationModule,
  type IntegrationPollFetcher,
  type IntegrationPresentation,
} from '@pertexo/integrations/server';
import { IntegrationRegistryError } from './node-catalog.errors.js';

export function registerIntegrationModules(
  modules: readonly IntegrationModule[],
) {
  const moduleKeys = new Set<string>();
  const lookups = new Map<string, ConnectionLookup>();
  const stepOwners = new Map<string, string>();
  const pollFetchers = new Map<string, IntegrationPollFetcher>();
  const presentations = new Map<string, IntegrationPresentation>();
  const entries = modules.flatMap((module) => {
    if (moduleKeys.has(module.key))
      throw new IntegrationRegistryError('module', module.key);
    moduleKeys.add(module.key);
    for (const lookup of module.lookups ?? []) {
      const key = `${module.key}:${lookup.key}`;
      if (
        lookups.has(key) ||
        !module.connections?.some(
          ({ authType }) => authType === lookup.authType,
        )
      )
        throw new IntegrationRegistryError('connection', key);
      lookups.set(key, lookup);
    }
    for (const connection of module.connections ?? []) {
      const test = connection.test;
      if (
        test.kind === 'lookup' &&
        lookups.get(`${module.key}:${test.key}`)?.authType !==
          connection.authType
      )
        throw new IntegrationRegistryError('connection', connection.authType);
    }
    return module.steps.map(
      ({ registration, presentation, createExecutor, fetchPoll }) => {
        const { key, version } = registration.manifest.definition;
        const identity = `${key}@${String(version)}`;
        const owner = stepOwners.get(key);
        if (
          (owner !== undefined && owner !== module.key) ||
          presentations.has(identity)
        )
          throw new IntegrationRegistryError('step', key);
        stepOwners.set(key, module.key);
        if (fetchPoll !== undefined) pollFetchers.set(identity, fetchPoll);
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
  const executorSummaryCodes = new Set(
    modules.flatMap((module) => module.executorSummaryCodes ?? []),
  );
  return {
    ...registerConnections(modules),
    connectionLookup: (provider: string, key: string) =>
      lookups.get(`${provider}:${key}`),
    acceptsExecutorSummary: (code: string) => executorSummaryCodes.has(code),
    pollFetcherFor: ({ key, version }: { key: string; version: number }) =>
      pollFetchers.get(`${key}@${String(version)}`),
    registrations: orderedSteps.map(({ registration }) => registration),
    createExecutors: (dependencies: IntegrationExecutorDependencies) =>
      orderedSteps.map(({ createExecutor }) => createExecutor(dependencies)),
    policies: modules.flatMap(({ policies }) => policies ?? []),
    presentationFor: ({ key, version }: { key: string; version: number }) =>
      presentations.get(`${key}@${String(version)}`),
  };
}

export const INTEGRATION_MODULE_REGISTRY =
  registerIntegrationModules(INTEGRATION_MODULES);

export const {
  connectionFormCatalog,
  connectionLookup: findConnectionLookup,
  findConnectionDefinition,
  findConnectionSlot,
  isRegisteredProvider,
} = INTEGRATION_MODULE_REGISTRY;

type RegisteredConnection = ConnectionDefinition &
  Readonly<{
    providerKey: string;
    icon: string;
  }>;

function registerConnections(modules: readonly IntegrationModule[]) {
  const connections = new Map<string, RegisteredConnection>();
  const primarySlots = new Map<string, RegisteredConnection>();
  const providers = new Set<string>();

  for (const module of modules) {
    for (const connection of module.connections ?? []) {
      if (connections.has(connection.authType))
        throw new IntegrationRegistryError('connection', connection.authType);
      const registered = Object.freeze({
        ...connection,
        providerKey: module.key,
        icon: module.presentation.icon,
      });
      connections.set(connection.authType, registered);
      providers.add(module.key);
      if (connection.slot.primary) {
        if (primarySlots.has(connection.slot.key))
          throw new IntegrationRegistryError('slot', connection.slot.key);
        primarySlots.set(connection.slot.key, registered);
      }
    }
  }

  const forms = [...connections.values()].map((entry) => {
    const primary = primarySlots.get(entry.slot.key);
    if (primary?.providerKey !== entry.providerKey)
      throw new IntegrationRegistryError('slot reference', entry.slot.key);
    return connectionForm(entry);
  });

  return {
    connectionFormCatalog: Object.freeze(forms),
    isRegisteredProvider: (providerKey: string) => providers.has(providerKey),
    findConnectionDefinition,
    findConnectionSlot,
  };

  function findConnectionDefinition(authType: string, providerKey?: string) {
    const connection = connections.get(authType);
    return providerKey === undefined || connection?.providerKey === providerKey
      ? connection
      : undefined;
  }

  function findConnectionSlot(key: string) {
    const primary = primarySlots.get(key);
    if (primary === undefined) return undefined;
    return {
      providerKey: primary.providerKey,
      authType: primary.authType,
      acceptedAuthTypes: [...connections.values()]
        .filter(({ slot }) => slot.key === key)
        .map(({ authType }) => authType),
    };
  }
}

function connectionForm(entry: RegisteredConnection) {
  const fields = generateSchemaDocument(entry.fields);
  if (containsSecretDefault(fields))
    throw new IntegrationRegistryError('secret default', entry.authType);
  return Object.freeze({
    providerKey: entry.providerKey,
    authType: entry.authType,
    presentation: entry.presentation,
    ...(entry.presets === undefined ? {} : { presets: entry.presets }),
    icon: entry.icon,
    fields,
    slot: entry.slot.key,
    test: entry.test.kind,
    testInput: connectionTestInput(entry.test),
    ...(entry.test.automatic === true
      ? { testAutomatically: true as const }
      : {}),
  });
}

function containsSecretDefault(value: unknown): boolean {
  if (isRecord(value)) {
    return (
      (value.secret === true && Object.hasOwn(value, 'default')) ||
      Object.values(value).some(containsSecretDefault)
    );
  }
  return Array.isArray(value) && value.some(containsSecretDefault);
}

function connectionTestInput(test: ConnectionDefinition['test']) {
  if (
    test.kind === 'oauth2' ||
    (test.kind === 'http' && test.target === 'entered_url')
  )
    return 'url' as const;
  return test.kind === 'http' && test.requiresConsent === true
    ? ('consent' as const)
    : ('provider' as const);
}
