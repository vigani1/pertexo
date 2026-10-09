import {
  AuthoringValidationUnavailableError,
  EMPTY_DEFINITION_CATALOG,
  WorkflowAuthoringValidator,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';
import type { DatabaseConfig } from '../../src/config.js';
import { createWorkflowAuthoringDatabase } from '../../src/authoring/workflows/database.js';
import type {
  WorkflowAuthoringDatabaseOptions,
  WorkflowAuthoringGraphValidator,
} from '../../src/authoring/workflows/types.js';

/** Synthetic authoring fixtures explicitly pin the canonical restricted policy.
 * Production derives these references from actual registry manifests instead.
 * This is a real compiled model owner, never a structural-only admission stub.
 */
export function createWorkflowAuthoringFixtureDatabase(
  config: DatabaseConfig,
  options: WorkflowAuthoringDatabaseOptions = {},
) {
  let validator: WorkflowAuthoringValidator | undefined;
  let closed = false;
  function admission(
    catalog: WorkflowDefinitionCatalog,
  ): WorkflowAuthoringGraphValidator {
    const projection = {
      definitions: catalog.definitions.map(({ key, version }) => ({
        definition: { key, version },
        policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
      })),
    };
    return (graph, command) => {
      if (closed) throw new AuthoringValidationUnavailableError('closed');
      validator ??= new WorkflowAuthoringValidator();
      return validator.validate(graph, projection, command);
    };
  }
  const database = createWorkflowAuthoringDatabase(config, {
    ...options,
    validateAuthoringGraph:
      options.validateAuthoringGraph ??
      admission(options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG),
  });
  let closePromise: Promise<void> | undefined;
  async function dispose() {
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
      throw new AggregateError(failures, 'Authoring fixture shutdown failed');
  }
  return Object.freeze({
    ...database,
    close: () => {
      closed = true;
      closePromise ??= dispose();
      return closePromise;
    },
  });
}
