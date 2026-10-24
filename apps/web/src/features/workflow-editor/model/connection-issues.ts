import type {
  ConnectionResponse,
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { describeConnectionRequirement } from '@/features/catalog/presentation.public';
import { isUsableConnection } from '@/features/connections/queries.public';
import type { WorkflowIssue } from '@/features/workflow-publish/public';
import { findDefinition } from './graph/adapter';
import type { GraphLevel } from './graph/scopes';

/** Credential readiness for enabled steps, using the complete authorized list. */
export function workflowConnectionIssues({
  graph,
  definitions,
  connections,
  available,
}: Readonly<{
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  available: boolean;
}>): readonly WorkflowIssue[] {
  const byId = new Map(
    connections.map((connection) => [connection.id, connection]),
  );
  function issuesIn(level: GraphLevel): WorkflowIssue[] {
    return level.nodes.flatMap((node) => {
      if (node.disabled ?? false) return [];
      const definition = findDefinition(definitions, node);
      const optional = new Set(definition?.optionalConnections ?? []);
      const issues = (definition?.connectionRequirements ?? []).flatMap(
        (requirement) => {
          const selectedId = node.connectionRefs[requirement];
          // An optional connection left empty is a choice, not a problem.
          if (selectedId === undefined && optional.has(requirement)) return [];
          const message = describeCredentialIssue({
            requirement,
            selectedId,
            connections: byId,
            available,
          });
          return message === undefined
            ? []
            : [
                {
                  id: `${node.id}:connection:${requirement}`,
                  message,
                  target: { nodeId: node.id },
                },
              ];
        },
      );
      const body = node.structured?.body;
      return body === undefined ? issues : [...issues, ...issuesIn(body)];
    });
  }
  return issuesIn(graph);
}

function describeCredentialIssue({
  requirement,
  selectedId,
  connections,
  available,
}: Readonly<{
  requirement: string;
  selectedId: string | undefined;
  connections: ReadonlyMap<string, ConnectionResponse>;
  available: boolean;
}>): string | undefined {
  const label = describeConnectionRequirement(requirement);
  if (!available)
    return 'Connections are unavailable here. Ask the server operator to check connection configuration and workspace access.';
  if (selectedId === undefined) return `Choose a ${label} for this step.`;
  const connection = connections.get(selectedId);
  if (connection === undefined)
    return `The selected ${label} is unavailable. Choose another one.`;
  if (isUsableConnection(connection, requirement)) return undefined;
  if (connection.authType !== requirement)
    return `Choose a ${label}; ${connection.name} has a different credential type.`;
  return connection.status === 'revoked'
    ? `${connection.name} was revoked. Choose another ${label}.`
    : `${connection.name} needs reauthorizing. Reconnect it or choose another ${label}.`;
}
