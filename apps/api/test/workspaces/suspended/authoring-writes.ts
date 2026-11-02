import { root, workflow } from './paths.js';
import { WRITES, type Write } from './writes.js';

/** The rest of authoring's commands. Refused while suspended and while being deleted. */
export const AUTHORING_WRITES: readonly Write[] = [
  ...WRITES.filter(({ name }) =>
    [
      'creating a workflow',
      'saving a draft',
      'publishing',
      'archiving a workflow',
      'duplicating a workflow',
      'commenting on a workflow',
    ].includes(name),
  ),
  {
    name: 'renaming a workflow',
    method: 'POST',
    path: (world) => `${workflow(world)}/rename`,
    payload: () => ({ name: 'Refused', expectedNameRevision: 1 }),
  },
  {
    name: 'restoring a version',
    method: 'POST',
    path: (world) => `${workflow(world)}/versions/${world.versionId}/restore`,
    headers: ({ draftTag }) => ({ 'if-match': draftTag }),
    payload: () => ({}),
  },
  {
    name: 'setting concurrency',
    method: 'PUT',
    path: (world) => `${workflow(world)}/concurrency`,
    payload: () => ({ limit: 2, overflow: 'queue', expectedRevision: 1 }),
  },
  {
    name: 'setting an error workflow',
    method: 'PUT',
    path: (world) => `${workflow(world)}/error-workflow`,
    payload: () => ({ targetWorkflowId: null, expectedRevision: 1 }),
  },
  {
    name: "changing a workflow's auto-pause",
    method: 'PUT',
    path: (world) => `${workflow(world)}/auto-pause`,
    payload: () => ({
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
    }),
  },
  {
    name: "resuming a workflow's triggers",
    method: 'POST',
    path: (world) => `${workflow(world)}/resume`,
    payload: () => ({ expectedPauseRevision: '1' }),
  },
  {
    name: "changing the workspace's auto-pause",
    method: 'PUT',
    path: (world) => `${root(world)}/auto-pause`,
    payload: () => ({ threshold: 11, expectedRevision: 1 }),
  },
  {
    name: 'adding an input case',
    method: 'POST',
    path: (world) => `${workflow(world)}/input-cases`,
    payload: ({ versionId }) => ({
      workflowVersionId: versionId,
      name: 'Refused',
      input: {},
    }),
  },
  {
    name: 'changing an input case',
    method: 'PUT',
    path: (world) => `${workflow(world)}/input-cases/${world.inputCaseId}`,
    payload: () => ({ expectedRevision: 1, name: 'Refused', input: {} }),
  },
  {
    name: 'deleting an input case',
    method: 'DELETE',
    path: (world) => `${workflow(world)}/input-cases/${world.inputCaseId}`,
    payload: () => ({ expectedRevision: 1 }),
  },
  {
    name: 'pinning a sample',
    method: 'PUT',
    path: (world) => `${workflow(world)}/draft/nodes/terminate/sample`,
    payload: () => ({
      expectedDraftRevision: 2,
      expectedSampleId: null,
      source: { kind: 'json', value: {} },
    }),
  },
  {
    name: 'asking for a review',
    method: 'POST',
    path: (world) => `${workflow(world)}/publication-review`,
    headers: ({ draftTag }) => ({ 'if-match': draftTag }),
    payload: () => ({ note: 'Refused' }),
  },
  {
    name: 'deciding a review',
    method: 'POST',
    path: (world) =>
      `${root(world)}/publication-requests/${world.reviewId}/decision`,
    payload: () => ({ decision: 'approve' }),
  },
];
