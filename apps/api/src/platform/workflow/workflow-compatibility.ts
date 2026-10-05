import {
  createWorkflowAuthoringDatabase,
  WorkflowDraftOperationUnavailableError,
  type DatabaseConfig,
  type DatabaseRuntime,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/api';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV2,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  WORKFLOW_CALL_RUNTIME_POLICIES_V1,
} from '@pertexo/workflow-engine';
import {
  WorkflowAuthoringValidator,
  AuthoringValidationUnavailableError,
} from '@pertexo/workflow-model/authoring-validation';
import type { WorkflowGraph } from '@pertexo/workflow-model/graph';
import { platformPortableDefinitionPolicy } from '@pertexo/node-catalog/server';

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

export function composeApiWorkflowCompatibilityRelease(
  release: PlatformRegistryRelease,
) {
  return [
    PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_ACTIVE.fingerprint,
    PLATFORM_REGISTRY_RELEASE_WORKFLOW_CALL_STAGED.fingerprint,
  ].includes(release.fingerprint)
    ? composeExecutableCompatibilityReleaseV3(release)
    : composeExecutableCompatibilityRelease(release);
}

export function createCoreWorkflowCompatibility(
  releaseCohort: PlatformReleaseCohort = 'core',
) {
  const registryReleaseSupport =
    platformExecutableRegistryHistory(releaseCohort);
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    registryReleaseSupport.map(composeApiWorkflowCompatibilityRelease),
  );
  const readinessSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeApiWorkflowCompatibilityRelease,
    ),
  );
  const variants = registryReleaseSupport.map((nodeRelease) => {
    const compatibilityRelease =
      composeApiWorkflowCompatibilityRelease(nodeRelease);
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
      portableCatalog: Object.freeze({
        ...platformPortableDefinitionPolicy(nodeRelease),
        // Destination CAS belongs to the full serving compatibility release,
        // while requirements retain the definition-selection projection.
        fingerprint: compatibilityRelease.fingerprint,
      }),
      authoringPolicies: Object.freeze({
        releaseFingerprint: compatibilityRelease.fingerprint,
        definitions: Object.freeze(
          nodeRelease.definitions.map((manifest) =>
            Object.freeze({
              definition: Object.freeze({
                key: manifest.definition.key,
                version: manifest.definition.version,
              }),
              policyReferences: Object.freeze(
                manifest.policyReferences.map((policy) =>
                  Object.freeze({
                    key: policy.key,
                    version: policy.version,
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
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
  validator: Pick<WorkflowAuthoringValidator, 'validate'>,
) {
  return {
    compatibilityReadinessReleases: readinessReleases,
    compatibilityReleaseVariants: variants.map(
      ({
        compatibilityRelease,
        compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
        portableCatalog,
        authoringPolicies,
      }) => ({
        compatibilityRelease: compatibilityReleaseDescription,
        definitionCatalog,
        placementDefinitionCatalog,
        portableCatalog,
        validateAuthoringGraph: (
          graph: WorkflowGraph,
          options: Readonly<{ signal?: AbortSignal }>,
        ) => validator.validate(graph, authoringPolicies, options),
        executableCompiler: (graph: WorkflowGraph) => {
          // The existing locked release remains the authority. A retained
          // release without exact native policies cannot compile Graph2. Keep
          // unsupported capability distinct from invalid user-authored graphs;
          // this branch neither registers a native catalog nor activates it.
          if (
            graph.schemaVersion === 2 &&
            !Object.values(WORKFLOW_CALL_RUNTIME_POLICIES_V1).every(
              (required) =>
                compatibilityRelease.policies.some(
                  (available) =>
                    available.key === required.key &&
                    available.version === required.version,
                ),
            )
          )
            throw new WorkflowDraftOperationUnavailableError();
          const compiled =
            graph.schemaVersion === 2
              ? buildWorkflowExecutableV3({
                  graph,
                  release: compatibilityRelease,
                })
              : buildWorkflowExecutableV2({
                  graph,
                  release: compatibilityRelease,
                });
          return Object.freeze({
            checksum: compiled.checksum,
            executableSchemaVersion: compiled.envelope.schemaVersion,
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
  // Lazy owner: failed synchronous database construction acquires no workers.
  let validator: WorkflowAuthoringValidator | undefined;
  let closed = false;
  const database = createWorkflowAuthoringDatabase(databaseConfig, {
    ...createCoreAuthoringOptions(
      compatibility.variants,
      compatibility.readinessSupport.descriptions,
      {
        validate: (...args) => {
          if (closed) throw new AuthoringValidationUnavailableError('closed');
          validator ??= new WorkflowAuthoringValidator();
          return validator.validate(...args);
        },
      },
    ),
    ...(runtime === undefined ? {} : { runtime }),
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    ...database,
    close: () => {
      closed = true;
      closePromise ??= closeCoreAuthoringDatabase(database, validator);
      return closePromise;
    },
  });
}

async function closeCoreAuthoringDatabase(
  database: WorkflowAuthoringDatabase,
  validator: WorkflowAuthoringValidator | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await validator?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  try {
    await database.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Authoring database shutdown failed');
}
