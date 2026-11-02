import { expect } from 'vitest';

import { lists, root, workflow } from './paths.js';
import type { Read } from './reads.js';

const answers = (body: unknown) => {
  expect(body).toBeTypeOf('object');
};

/** Authoring's reads, each held to what it shows and not just that it answers. */
export const AUTHORING_READS: readonly Read[] = [
  {
    name: "a workflow's draft",
    as: 'viewer',
    path: (world) => `${workflow(world)}/draft`,
    shows: (body: { graph: { nodes: readonly { id: string }[] } }) => {
      expect(body.graph.nodes.map(({ id }) => id)).toEqual([
        'manual',
        'terminate',
      ]);
    },
  },
  {
    name: "a workflow's comments",
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments`,
    shows: lists(({ threadId }) => threadId),
  },
  {
    name: 'a comment thread',
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments/${world.threadId}`,
    shows: (
      body: { thread: { id: string }; comments: readonly { body: string }[] },
      world,
    ) => {
      expect(body.thread.id).toBe(world.threadId);
      expect(body.comments.map((comment) => comment.body)).toEqual(['Browsed']);
    },
  },
  {
    name: 'who a comment can mention',
    as: 'viewer',
    path: (world) => `${workflow(world)}/comments/people`,
    shows: (body: { items: readonly unknown[] }) => {
      expect(body.items).toHaveLength(2);
    },
  },
  {
    name: 'who else is on a workflow',
    as: 'viewer',
    path: (world) =>
      `${workflow(world)}/presence?tabId=00000000-0000-4000-8000-000000000001`,
    shows: answers,
  },
  {
    name: "a workflow's input cases",
    as: 'viewer',
    path: (world) => `${workflow(world)}/input-cases`,
    shows: lists(({ inputCaseId }) => inputCaseId),
  },
  {
    name: 'an input case',
    as: 'viewer',
    path: (world) => `${workflow(world)}/input-cases/${world.inputCaseId}`,
    shows: (body: { case: object }, world) => {
      expect(body.case).toMatchObject({
        id: world.inputCaseId,
        name: 'Browsed case',
        input: { note: 'browsed' },
      });
    },
  },
  {
    name: 'a pinned sample',
    as: 'viewer',
    path: (world) => `${workflow(world)}/draft/nodes/manual/sample`,
    shows: (body: object) => {
      expect(body).toMatchObject({ sample: { state: 'pinned' } });
    },
  },
  {
    name: 'a publication request',
    as: 'viewer',
    path: (world) => `${root(world)}/publication-requests/${world.reviewId}`,
    shows: (body: { request: object }, world) => {
      expect(body.request).toMatchObject({ id: world.reviewId });
    },
  },
  {
    name: "a draft's pinned samples",
    as: 'viewer',
    path: (world) => `${workflow(world)}/draft/samples`,
    shows: (body: { items: readonly { nodeId: string }[] }) => {
      expect(body.items.map(({ nodeId }) => nodeId)).toEqual(['manual']);
    },
  },
  {
    name: "a workflow's concurrency",
    as: 'viewer',
    path: (world) => `${workflow(world)}/concurrency`,
    shows: (body: object) => {
      expect(body).toMatchObject({ limit: null, revision: 1 });
    },
  },
  {
    name: "a workflow's error workflow",
    as: 'viewer',
    path: (world) => `${workflow(world)}/error-workflow`,
    shows: (body: object) => {
      expect(body).toMatchObject({ targetWorkflowId: null, revision: 1 });
    },
  },
  {
    name: "a workflow's auto-pause",
    as: 'viewer',
    path: (world) => `${workflow(world)}/auto-pause`,
    shows: (body: object) => {
      expect(body).toMatchObject({ enabled: true, thresholdOverride: null });
    },
  },
  {
    name: "a workflow's publication review",
    as: 'viewer',
    path: (world) => `${workflow(world)}/publication-review`,
    shows: (body: { request: { id: string } | null }, world) => {
      expect(body.request?.id).toBe(world.reviewId);
    },
  },
  {
    name: 'a draft check',
    as: 'viewer',
    path: (world) => `${workflow(world)}/validate`,
    query: {},
    shows: (body: object) => {
      expect(body).toMatchObject({ valid: true, issues: [] });
    },
  },
  {
    name: 'the workspace auto-pause',
    as: 'viewer',
    path: (world) => `${root(world)}/auto-pause`,
    shows: (body: object) => {
      expect(body).toMatchObject({ threshold: 10 });
    },
  },
];
