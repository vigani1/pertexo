import { expect, it } from 'vitest';
import {
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowListResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
} from '@pertexo/contracts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-11-10T10:00:00.000Z';
const step = {
  id: 'step',
  definition: { key: 'core.manual', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: { futureUserConfig: { arbitrary: true } },
  inputMappings: {},
  connectionRefs: {},
};
const graph = { nodes: [step], edges: [], settings: {} };
it('strips future response metadata recursively while retaining arbitrary graph configuration', () => {
  const result = workflowDraftResponseSchema.parse({
    workflowId: id,
    revision: 1,
    graph: {
      ...graph,
      nodes: [{ ...step, futureNodeMetadata: true }],
      futureGraphMetadata: true,
    },
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
      issues: [],
      futureMetadata: true,
    },
    updatedAt: at,
    futureMetadata: true,
  });
  expect(result).not.toHaveProperty('futureMetadata');
  expect(result.graph).not.toHaveProperty('futureGraphMetadata');
  expect(result.graph.nodes[0]).not.toHaveProperty('futureNodeMetadata');
  expect(result.graph.nodes[0]?.config).toEqual(step.config);
  expect(result.compatibility).not.toHaveProperty('futureMetadata');
  expect(
    workflowDraftSaveRequestSchema.safeParse({ graph, futureInput: true })
      .success,
  ).toBe(false);
  expect(
    workflowDraftSaveRequestSchema.safeParse({
      graph: {
        ...graph,
        nodes: [{ ...step, futureNodeMetadata: true }],
        futureGraphMetadata: true,
      },
    }).success,
  ).toBe(false);
});
it('strips nested list projection metadata', () => {
  const result = workflowListResponseSchema.parse({
    items: [
      {
        id,
        workspaceId: id,
        name: 'One',
        nameRevision: 1,
        lifecycleStatus: 'active',
        lifecycleRevision: 1,
        activationStatus: 'inactive',
        webhookSetupRequired: false,
        publishedVersionId: null,
        createdAt: at,
        updatedAt: at,
        futureMetadata: true,
      },
    ],
    nextCursor: null,
    futureMetadata: true,
  });
  expect(result).not.toHaveProperty('futureMetadata');
  expect(result.items[0]).not.toHaveProperty('futureMetadata');
});

it('strips future template-origin metadata while retaining the recorded origin', () => {
  const origin = {
    templateId: 'retired-example',
    templateVersion: 7,
    baseManifestDigest: 'a'.repeat(64),
    creationCommandDigest: 'b'.repeat(64),
    derivation: 'inherited',
  };
  const workflow = {
    id,
    workspaceId: id,
    name: 'One',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    webhookSetupRequired: false,
    publishedVersionId: null,
    createdAt: at,
    updatedAt: at,
  };
  expect(
    workflowTemplateOriginProjectionResponseSchema.parse({
      workflow,
      templateOrigin: { ...origin, futureMetadata: true },
    }),
  ).toEqual({ workflow, templateOrigin: origin });
});
