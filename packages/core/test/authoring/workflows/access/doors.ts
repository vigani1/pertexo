import { randomUUID } from 'node:crypto';

import { authoring, workspaceId } from '../../../support/workflow-authoring.js';
import { graphWith, inputCases, type Target } from './world.js';

export type As = Readonly<{ workspaceId: string; actorId: string }>;
export const as = (actor: string): As => ({ workspaceId, actorId: actor });
export const key = () => ({ idempotencyKey: randomUUID() });

/** Every command with a workflow's door, ready to pass everything but authority. */
export const WRITES: Readonly<
  Record<string, (actor: As, target: Target) => Promise<unknown>>
> = {
  'saving a draft': (actor, { id, tag }) =>
    authoring.saveDraft({
      ...actor,
      workflowId: id,
      graphJson: graphWith('refused'),
      expectedRevision: 1,
      representationTag: tag,
    }),
  'restoring a version': (actor, { id, versionId, tag }) =>
    authoring.restoreWorkflowVersion({
      ...actor,
      ...key(),
      workflowId: id,
      versionId,
      representationTag: tag,
    }),
  publishing: (actor, { id, tag }) =>
    authoring.publishWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      representationTag: tag,
      requestHash: 'b'.repeat(64),
    }),
  archiving: (actor, { id }) =>
    authoring.transitionWorkflowLifecycle({
      ...actor,
      ...key(),
      workflowId: id,
      command: 'archive',
      expectedLifecycleRevision: 1,
    }),
  renaming: (actor, { id }) =>
    authoring.renameWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      name: 'Refused',
      expectedNameRevision: 1,
    }),
  'setting concurrency': (actor, { id }) =>
    authoring.concurrency.updateSettings({
      ...actor,
      ...key(),
      workflowId: id,
      limit: 2,
      expectedRevision: 1,
    }),
  'setting an error workflow': (actor, { id }) =>
    authoring.errorWorkflow.updateSettings({
      ...actor,
      ...key(),
      workflowId: id,
      targetWorkflowId: null,
      expectedRevision: 1,
    }),
  'listing error workflow targets': (actor, { id }) =>
    authoring.errorWorkflow.listTargets({ ...actor, workflowId: id }),
  'pinning a sample': (actor, { id }) =>
    authoring.stepSamples.put({
      ...actor,
      ...key(),
      workflowId: id,
      nodeId: 'any',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      source: { kind: 'json', value: {} },
    }),
  'adding an input case': (actor, { id, versionId }) =>
    inputCases.createCase({
      ...actor,
      ...key(),
      workflowId: id,
      workflowVersionId: versionId,
      name: 'Refused',
      input: {},
    }),
  'asking for a review': (actor, { id, tag }) =>
    authoring.publicationReviews.request({
      ...actor,
      ...key(),
      workflowId: id,
      representationTag: tag,
      note: 'Refused',
    }),
  "changing a workflow's auto-pause": (actor, { id }) =>
    authoring.autoPause.updateWorkflowSettings({
      ...actor,
      ...key(),
      workflowId: id,
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
    }),
  'resuming triggers': (actor, { id }) =>
    authoring.autoPause.resumeWorkflow({
      ...actor,
      ...key(),
      workflowId: id,
      expectedPauseRevision: '0',
    }),
};

/** Each read, and what it shows of the workflow a person can reach. */
export const READS: Readonly<
  Record<
    string,
    Readonly<{
      read: (actor: As, target: Target) => Promise<unknown>;
      shows: (target: Target) => unknown;
      /** A list or lookup answers with nothing; a door refuses. */
      hiddenAnswer: 'refused' | null | { items: readonly never[] };
    }>
  >
> = {
  'a workflow': {
    read: (actor, { id }) =>
      authoring.getWorkflow(actor.workspaceId, id, actor.actorId),
    shows: ({ id }) => ({ id, name: 'Open' }),
    hiddenAnswer: null,
  },
  'a draft': {
    read: (actor, { id }) =>
      authoring.getDraft(actor.workspaceId, id, actor.actorId),
    shows: () => ({ revision: 1 }),
    hiddenAnswer: null,
  },
  'a version': {
    read: (actor, { id, versionId }) =>
      authoring.getVersion(actor.workspaceId, id, versionId, actor.actorId),
    shows: ({ versionId }) => ({ id: versionId, versionNumber: 1 }),
    hiddenAnswer: null,
  },
  'a draft check': {
    read: (actor, { id }) =>
      authoring.validateDraft(actor.workspaceId, id, actor.actorId),
    shows: () => ({ validation: { ok: true } }),
    hiddenAnswer: null,
  },
  'the concurrency settings': {
    read: (actor, { id }) =>
      authoring.concurrency.readSettings({ ...actor, workflowId: id }),
    shows: () => ({ limit: null, revision: 1, overflow: 'queue' }),
    hiddenAnswer: 'refused',
  },
  'the error workflow': {
    read: (actor, { id }) =>
      authoring.errorWorkflow.readSettings({ ...actor, workflowId: id }),
    shows: () => ({ targetWorkflowId: null, revision: 1 }),
    hiddenAnswer: 'refused',
  },
  "a workflow's auto-pause": {
    read: (actor, { id }) =>
      authoring.autoPause.readWorkflowSettings({ ...actor, workflowId: id }),
    shows: () => ({ enabled: true, thresholdOverride: null }),
    hiddenAnswer: 'refused',
  },
  'the discussions': {
    read: (actor, { id }) =>
      authoring.collaboration.list({
        ...actor,
        workflowId: id,
        limit: 10,
        status: 'all',
        scope: 'all',
      }),
    shows: () => ({ nextCursor: null }),
    hiddenAnswer: 'refused',
  },
  'the input cases': {
    read: (actor, { id }) =>
      inputCases.listCases({ ...actor, workflowId: id, limit: 10 }),
    shows: () => ({ items: [] }),
    hiddenAnswer: 'refused',
  },
  'the pinned samples': {
    read: (actor, { id }) =>
      authoring.stepSamples.list({ ...actor, workflowId: id }),
    shows: () => ({ items: [] }),
    hiddenAnswer: 'refused',
  },
  'the review overview': {
    read: (actor, { id }) =>
      authoring.publicationReviews.overview({ ...actor, workflowId: id }),
    shows: () => ({ required: false, request: null }),
    hiddenAnswer: 'refused',
  },
};
