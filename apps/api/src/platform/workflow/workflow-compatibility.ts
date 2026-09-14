import {
  createWorkflowAuthoringDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/api';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

type PlatformRegistryRelease = ReturnType<
  typeof platformExecutableRegistryHistory
>[number];
type PlatformDefinitionManifest =
  PlatformRegistryRelease['definitions'][number];
type ProjectedDefinition = ReturnType<typeof projectDefinition>;

function registryIdentity(value: {
  readonly key: string;
  readonly version: number;
}): string {
  return `${value.key}\u0000${String(value.version)}`;
}

function projectDefinition(manifest: PlatformDefinitionManifest) {
  return Object.freeze({
    lifecycle: manifest.lifecycle,
    definition: Object.freeze({
      ...manifest.definition,
      ...(manifest.integration === undefined
        ? {}
        : {
            integration: Object.freeze({
              ...manifest.integration,
              connectionSlots: Object.freeze([
                ...manifest.connectionRequirements,
              ]),
            }),
          }),
    }),
  });
}

function projectExecutableDefinitions(
  release: PlatformRegistryRelease,
): readonly ProjectedDefinition[] {
  const activeExecutors = new Set(
    release.executors
      .filter((executor) => executor.lifecycle === 'active')
      .map((executor) => registryIdentity(executor.executor)),
  );
  return Object.freeze(
    release.definitions.flatMap((manifest) =>
      activeExecutors.has(registryIdentity(manifest.executor))
        ? [projectDefinition(manifest)]
        : [],
    ),
  );
}

function definitionCatalog(
  releaseFingerprint: string,
  definitions: readonly ProjectedDefinition[],
  include: (definition: ProjectedDefinition) => boolean,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    releaseFingerprint,
    definitions: Object.freeze(
      definitions.filter(include).map(({ definition }) => definition),
    ),
  });
}

function projectDefinitionCatalogs(
  release: PlatformRegistryRelease,
  releaseFingerprint: string,
) {
  const definitions = projectExecutableDefinitions(release);
  return Object.freeze({
    definitionCatalog: definitionCatalog(
      releaseFingerprint,
      definitions,
      (definition) =>
        definition.lifecycle === 'active' ||
        definition.lifecycle === 'deprecated',
    ),
    placementDefinitionCatalog: definitionCatalog(
      releaseFingerprint,
      definitions,
      (definition) => definition.lifecycle === 'active',
    ),
  });
}

export function createCoreWorkflowCompatibility(
  releaseCohort: PlatformReleaseCohort = 'core',
) {
  const registryReleaseSupport =
    platformExecutableRegistryHistory(releaseCohort);
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    registryReleaseSupport.map(composeExecutableCompatibilityRelease),
  );
  const readinessSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const variants = registryReleaseSupport.map((nodeRelease) => {
    const compatibilityRelease =
      composeExecutableCompatibilityRelease(nodeRelease);
    const compatibilityReleaseDescription = releaseSupport.descriptions.find(
      ({ epoch, fingerprint }) =>
        epoch === compatibilityRelease.epoch &&
        fingerprint === compatibilityRelease.fingerprint,
    );
    if (compatibilityReleaseDescription === undefined)
      throw new Error('Core compatibility release description is missing');
    const { definitionCatalog, placementDefinitionCatalog } =
      projectDefinitionCatalogs(nodeRelease, compatibilityRelease.fingerprint);
    return Object.freeze({
      compatibilityRelease,
      compatibilityReleaseDescription,
      definitionCatalog,
      placementDefinitionCatalog,
    });
  });
  if (variants.length === 0)
    throw new Error('Core compatibility release support is empty');
  return Object.freeze({
    releaseSupport,
    readinessSupport,
    variants: Object.freeze(variants),
  });
}

export function createCoreAuthoringOptions(
  variants: ReturnType<typeof createCoreWorkflowCompatibility>['variants'],
  readinessReleases: ReturnType<
    typeof createCoreWorkflowCompatibility
  >['readinessSupport']['descriptions'],
) {
  return {
    compatibilityReadinessReleases: readinessReleases,
    compatibilityReleaseVariants: variants.map(
      ({
        compatibilityRelease,
        compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
      }) => ({
        compatibilityRelease: compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
        executableCompiler: (
          graph: Parameters<typeof buildWorkflowExecutableV2>[0]['graph'],
        ) => {
          const compiled = buildWorkflowExecutableV2({
            graph,
            release: compatibilityRelease,
          });
          return Object.freeze({
            checksum: compiled.checksum,
            executableSchemaVersion: 2 as const,
            executableJson: compiled.envelope,
            compatibilityReleaseEpoch:
              compiled.envelope.compatibilityReleaseEpoch,
            compatibilityReleaseFingerprint:
              compiled.envelope.compatibilityReleaseFingerprint,
          });
        },
      }),
    ),
  } as const;
}

export function createCoreWorkflowAuthoringDatabase(
  databaseConfig: DatabaseConfig,
  releaseCohort: PlatformReleaseCohort = 'core',
  runtime?: DatabaseRuntime,
): WorkflowAuthoringDatabase {
  const compatibility = createCoreWorkflowCompatibility(releaseCohort);
  return createWorkflowAuthoringDatabase(databaseConfig, {
    ...createCoreAuthoringOptions(
      compatibility.variants,
      compatibility.readinessSupport.descriptions,
    ),
    ...(runtime === undefined ? {} : { runtime }),
  });
}
