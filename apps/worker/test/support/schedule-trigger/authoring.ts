import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { WorkflowAuthoringValidator } from '@pertexo/workflow-model/server';

export function scheduleAuthoringOptions(
  validator: Pick<WorkflowAuthoringValidator, 'validate'>,
) {
  const nodeCatalog = PLATFORM_NODE_CATALOG;
  const catalog = composeExecutableCatalog(nodeCatalog);
  const authoringPolicies = {
    definitions: nodeCatalog.definitions.map((manifest) => ({
      definition: {
        key: manifest.definition.key,
        version: manifest.definition.version,
      },
      policyReferences: manifest.policyReferences.map(({ key, version }) => ({
        key,
        version,
      })),
    })),
  };
  const definitionCatalog = Object.freeze({
    definitions: Object.freeze(
      nodeCatalog.definitions.map(
        ({ definition, integration, connectionRequirements }) =>
          Object.freeze({
            ...definition,
            ...(integration === undefined
              ? {}
              : {
                  integration: Object.freeze({
                    ...integration,
                    connectionSlots: Object.freeze([...connectionRequirements]),
                  }),
                }),
          }),
      ),
    ),
  });
  return Object.freeze({
    definitionCatalog,
    databaseOptions: Object.freeze({
      definitionCatalog,
      validateAuthoringGraph: (
        graph: WorkflowGraph,
        command: Readonly<{ signal?: AbortSignal }>,
      ) => validator.validate(graph, authoringPolicies, command),
      executableCompiler: (
        graph: Parameters<typeof buildWorkflowExecutable>[0]['graph'],
      ) => {
        const compiled = buildWorkflowExecutable({ graph, catalog });
        return {
          checksum: compiled.checksum,
          executableJson: compiled.envelope,
        };
      },
    }),
  });
}
