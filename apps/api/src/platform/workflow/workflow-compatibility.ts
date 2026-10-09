import {
  createWorkflowAuthoringDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/authoring';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import { platformPortableDefinitionPolicy } from '@pertexo/node-catalog/server';

/** The definitions authoring accepts, with each integration's connection slots. */
function projectDefinitionCatalog(catalog: typeof PLATFORM_NODE_CATALOG) {
  return Object.freeze({
    schemaVersion: 1 as const,
    definitions: Object.freeze(
      catalog.definitions.map((manifest) =>
        Object.freeze({
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
      ),
    ),
  });
}

function buildCoreWorkflowCompatibility() {
  const nodeCatalog = PLATFORM_NODE_CATALOG;
  return Object.freeze({
    catalog: composeExecutableCatalog(nodeCatalog),
    definitionCatalog: projectDefinitionCatalog(nodeCatalog),
    portableCatalog: platformPortableDefinitionPolicy(),
    authoringPolicies: Object.freeze({
      definitions: Object.freeze(
        nodeCatalog.definitions.map((manifest) =>
          Object.freeze({
            definition: Object.freeze({
              key: manifest.definition.key,
              version: manifest.definition.version,
            }),
            policyReferences: Object.freeze(
              manifest.policyReferences.map((policy) =>
                Object.freeze({ key: policy.key, version: policy.version }),
              ),
            ),
          }),
        ),
      ),
    }),
  });
}

let coreWorkflowCompatibility:
  ReturnType<typeof buildCoreWorkflowCompatibility> | undefined;

/** The node catalog is static, so its compiled compatibility is built once. */
export function createCoreWorkflowCompatibility() {
  coreWorkflowCompatibility ??= buildCoreWorkflowCompatibility();
  return coreWorkflowCompatibility;
}

export function createCoreAuthoringOptions(
  compatibility: ReturnType<typeof createCoreWorkflowCompatibility>,
  validator: Pick<WorkflowAuthoringValidator, 'validate'>,
) {
  return {
    definitionCatalog: compatibility.definitionCatalog,
    portableCatalog: compatibility.portableCatalog,
    validateAuthoringGraph: (
      graph: WorkflowGraph,
      options: Readonly<{ signal?: AbortSignal }>,
    ) => validator.validate(graph, compatibility.authoringPolicies, options),
    executableCompiler: (
      graph: Parameters<typeof buildWorkflowExecutable>[0]['graph'],
    ) => {
      const compiled = buildWorkflowExecutable({
        graph,
        catalog: compatibility.catalog,
      });
      return Object.freeze({
        checksum: compiled.checksum,
        executableJson: compiled.envelope,
      });
    },
  } as const;
}

export function createCoreWorkflowAuthoringDatabase(
  databaseConfig: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowAuthoringDatabase {
  const compatibility = createCoreWorkflowCompatibility();
  // Lazy owner: failed synchronous database construction acquires no workers.
  let validator: WorkflowAuthoringValidator | undefined;
  let closed = false;
  const database = createWorkflowAuthoringDatabase(databaseConfig, {
    ...createCoreAuthoringOptions(compatibility, {
      validate: (...args) => {
        if (closed) throw new AuthoringValidationUnavailableError('closed');
        validator ??= new WorkflowAuthoringValidator();
        return validator.validate(...args);
      },
    }),
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
