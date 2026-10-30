import { randomUUID } from 'node:crypto';

import { emptyWorkflowGraph } from '../real-api/graphs.js';
import type { World } from './world.js';

type Write = Readonly<{
  name: string;
  method: 'POST' | 'PUT';
  path: (world: World) => string;
  headers?: (world: World) => Record<string, string>;
  payload?: (world: World) => object;
  /** The guards that answer 403 rather than hide the workspace. */
  forbidden?: true;
}>;

const root = ({ workspaceId }: World) => `/v1/workspaces/${workspaceId}`;
const workflow = (world: World) =>
  `${root(world)}/workflows/${world.workflowId}`;

/**
 * What must stay refused, each against a real resource and with a body the
 * route would accept, so that the refusal comes from the workspace's state.
 * Several sit behind the same guards as the reads that open.
 */
export const WRITES: readonly Write[] = [
  {
    name: 'creating a workflow',
    method: 'POST',
    path: (world) => `${root(world)}/workflows`,
    payload: () => ({ name: 'Refused' }),
  },
  {
    name: 'saving a draft',
    method: 'PUT',
    path: (world) => `${workflow(world)}/draft`,
    headers: ({ draftTag }) => ({ 'if-match': draftTag }),
    payload: () => ({ graph: emptyWorkflowGraph() }),
  },
  {
    name: 'publishing',
    method: 'POST',
    path: (world) => `${workflow(world)}/publish`,
    headers: ({ draftTag }) => ({ 'if-match': draftTag }),
  },
  {
    name: 'starting a run',
    method: 'POST',
    path: (world) => `${workflow(world)}/runs`,
    payload: () => ({ input: {} }),
  },
  {
    name: 'replaying a run',
    method: 'POST',
    path: (world) => `${root(world)}/runs/${world.runId}/replay`,
    payload: ({ versionId }) => ({ workflowVersionId: versionId, input: {} }),
  },
  {
    name: 'archiving a workflow',
    method: 'POST',
    path: (world) => `${workflow(world)}/archive`,
    payload: () => ({ expectedLifecycleRevision: 1 }),
  },
  {
    name: 'duplicating a workflow',
    method: 'POST',
    path: (world) => `${workflow(world)}/duplicate`,
    payload: () => ({ name: 'Refused copy' }),
  },
  {
    name: 'creating a tag',
    method: 'POST',
    path: (world) => `${root(world)}/workflow-tags`,
    payload: () => ({ key: 'refused' }),
  },
  {
    name: 'creating a folder',
    method: 'POST',
    path: (world) => `${root(world)}/workflow-folders`,
    payload: () => ({ name: 'Refused', parentId: null }),
  },
  {
    name: 'favoriting a workflow',
    method: 'PUT',
    path: (world) => `${workflow(world)}/favorite`,
    payload: () => ({ favorite: true }),
  },
  {
    name: 'commenting on a workflow',
    method: 'POST',
    path: (world) => `${workflow(world)}/comments`,
    payload: () => ({ body: 'Refused', mentionUserIds: [] }),
  },
  {
    name: 'announcing presence on a workflow',
    method: 'PUT',
    path: (world) => `${workflow(world)}/presence/${randomUUID()}`,
    payload: () => ({
      sequence: 1,
      editing: false,
      dirty: false,
      baseRevision: null,
    }),
  },
  {
    name: 'marking the inbox read',
    method: 'POST',
    path: (world) => `${root(world)}/notifications/read-all`,
    payload: () => ({ revision: '0' }),
  },
  {
    name: 'changing inbox preferences',
    method: 'PUT',
    path: (world) => `${root(world)}/notifications/preferences`,
    payload: () => ({
      mode: null,
      hour: 9,
      timeZone: 'UTC',
      expectedRevision: 0,
    }),
  },
  {
    name: 'deciding an approval',
    method: 'POST',
    path: (world) => `${root(world)}/pending-tasks/${world.taskId}/decide`,
    payload: () => ({ decision: 'approved' }),
  },
  {
    name: 'submitting a request',
    method: 'POST',
    path: (world) =>
      `${root(world)}/pending-tasks/${world.requestTaskId}/submit`,
    payload: () => ({ values: { message: 'Refused' } }),
  },
  {
    name: 'creating a connection',
    method: 'POST',
    path: (world) => `${root(world)}/connections`,
    payload: () => ({
      providerKey: 'signing',
      name: 'Refused key',
      credential: { type: 'hmac_key', signingKey: 'fixture-demo-0043' },
    }),
  },
  {
    name: 'saving variables',
    method: 'PUT',
    path: (world) => `${root(world)}/variables`,
    payload: () => ({ expectedRevision: 0, values: { REFUSED: 'yes' } }),
  },
  {
    name: 'creating a data table',
    method: 'POST',
    path: (world) => `${root(world)}/data-tables`,
    payload: () => ({
      name: 'Refused',
      columns: [{ name: 'note', type: 'text', required: false }],
    }),
  },
  {
    name: 'inviting a member',
    method: 'POST',
    path: (world) => `${root(world)}/invitations`,
    payload: () => ({
      email: `refused-${randomUUID()}@example.test`,
      role: 'viewer',
    }),
    forbidden: true,
  },
  {
    name: 'creating an API token',
    method: 'POST',
    path: (world) => `${root(world)}/api-tokens`,
    payload: () => ({ name: 'Refused', scopes: ['workflow:read'] }),
    forbidden: true,
  },
  {
    name: 'submitting a form as a member',
    method: 'POST',
    path: (world) =>
      `${root(world)}/workflows/${world.formWorkflowId}/form/submit`,
    payload: ({ formVersionId }) => ({
      versionId: formVersionId,
      values: { note: 'refused' },
    }),
  },
  {
    name: "changing a form's access",
    method: 'POST',
    path: (world) =>
      `${root(world)}/workflows/${world.formWorkflowId}/form/access`,
    payload: () => ({ access: 'members', expectedRevision: 1 }),
  },
];

export const durableWorkspaceFacts = `select
  (select count(*)::int from app.workflows where workspace_id=$1) workflows,
  (select count(*)::int from app.workflow_versions where workspace_id=$1) versions,
  (select coalesce(sum(revision),0)::int from app.workflow_drafts where workspace_id=$1) draft_revisions,
  (select count(*)::int from app.workflow_runs where workspace_id=$1) runs,
  (select count(*)::int from app.workflow_tags where workspace_id=$1) tags,
  (select count(*)::int from app.workflow_folders where workspace_id=$1) folders,
  (select count(*)::int from app.workflow_favorites where workspace_id=$1) favorites,
  (select count(*)::int from app.workflow_comment_threads where workspace_id=$1) comment_threads,
  (select count(*)::int from app.connections where workspace_id=$1) connections,
  (select count(*)::int from app.workspace_data_tables where workspace_id=$1) data_tables,
  (select count(*)::int from app.api_tokens where workspace_id=$1) api_tokens,
  (select count(*)::int from app.workspace_invitations where workspace_id=$1) invitations,
  (select count(*)::int from app.pending_run_tasks where workspace_id=$1 and status<>'pending') decided_tasks`;
