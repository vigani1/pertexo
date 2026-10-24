import {
  connectionScopeSql,
  type ConnectionScope,
} from '../../../tenant-access/resources/connections/scope.js';
import { bindResourcePredicate } from '../../../tenant-access/resources/scope.queries.js';
import type { PoolClient } from 'pg';
import {
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  type PortableConnectionBinding,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import type { AuthoringCatalogs } from '../../workflows/catalogs.js';
import { WorkflowPromotionError } from '../contract.js';
import type { PromotionSource, PromotionSourceSet } from './source.js';
import { promotionNodes } from './graph.js';

export async function rebindPromotionConnections(
  client: PoolClient,
  workspaceId: string,
  {
    scope,
    source,
    sources,
    catalogs,
    report,
  }: Readonly<{
    scope: ConnectionScope;
    source: PromotionSource;
    sources: PromotionSourceSet;
    catalogs: AuthoringCatalogs;
    report: (requirement: WorkflowPromotionRequirement) => void;
  }>,
): Promise<WorkflowGraph> {
  const catalog = catalogs.portableCatalog;
  if (catalog === undefined)
    throw new WorkflowPromotionError(
      'unavailable',
      'The workflow portability catalog is unavailable.',
    );
  const manifest = projectWorkflowPortableManifest(source.graph, catalog);
  const sourceNodes = new Map(
    [...promotionNodes(source.graph)].map((node) => [node.id, node]),
  );
  const names = [
    ...new Set(
      sources.connections.map((connection) => connection.normalized_name),
    ),
  ];
  const parameters: unknown[] = [workspaceId, names];
  const permitted = bindResourcePredicate(
    connectionScopeSql(scope),
    parameters,
  );
  const targets =
    names.length === 0
      ? []
      : (
          await client.query<{
            id: string;
            name: string;
            normalized_name: string;
            provider_key: string;
            auth_type: string;
            status: string;
          }>(
            `select id,name,lower(name) normalized_name,provider_key,auth_type,status from app.connections connection where workspace_id=$1 and lower(name)=any($2::text[]) and ${permitted} order by id for share`,
            parameters,
          )
        ).rows;
  const bindings: PortableConnectionBinding[] = [];
  for (const slot of manifest.connectionSlots) {
    const sourceId = sourceNodes.get(slot.nodeId)?.connectionRefs[slot.slot];
    const connection = sources.connections.find(
      (candidate) => candidate.id === sourceId,
    );
    const matches =
      connection?.provider_key !== slot.providerKey ||
      connection.auth_type !== slot.authType
        ? []
        : targets.filter(
            (candidate) =>
              candidate.normalized_name === connection.normalized_name &&
              candidate.provider_key === slot.providerKey &&
              candidate.auth_type === slot.authType &&
              candidate.status === 'active',
          );
    const matched = matches.length === 1 ? matches[0] : undefined;
    report({
      workflowId: source.workflowId,
      nodeId: slot.nodeId,
      kind: 'connection',
      name: connection?.name ?? slot.slot,
      status: matched === undefined ? 'missing' : 'ready',
      detail:
        matched === undefined
          ? 'Create one active target connection with the same name, provider and authentication type. Ambiguous names must be resolved first.'
          : 'Matched an active target connection by name, provider and authentication type.',
    });
    if (matched !== undefined)
      bindings.push({
        nodeId: slot.nodeId,
        slot: slot.slot,
        connectionId: matched.id,
      });
  }
  return inspectWorkflowPortableManifest(manifest, bindings, catalog).graph;
}
