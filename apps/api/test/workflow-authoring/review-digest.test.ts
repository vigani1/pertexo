import { expect, it } from 'vitest';
import { portableGraphDigest } from '@pertexo/workflow-model';
import {
  serializeWorkflowDraft,
  serializeWorkflowList,
  serializeWorkflowVersions,
} from '../../src/workflow-authoring/http/serializers.js';
import { draft, version, workflow } from './workflow-commands.fixture.js';

it('returns the export review identity on draft and immutable version reads', async () => {
  const source = draft();
  const result = await serializeWorkflowDraft(source, true);
  expect(result.body).toHaveProperty(
    'graphDigest',
    await portableGraphDigest(source.graphJson),
  );
  const published = version();
  const versions = await serializeWorkflowVersions([published], null, {
    graphDigest: true,
    publishedBy: false,
  });
  expect(versions.items[0]).toHaveProperty(
    'graphDigest',
    await portableGraphDigest(published.graphJson),
  );
  expect(versions.items[0]).not.toHaveProperty('publishedBy');
});

it('names who published a version only when the reader asks for it', async () => {
  const published = version();
  const plain = await serializeWorkflowVersions([published], null);
  expect(plain.items[0]).not.toHaveProperty('publishedBy');
  const named = await serializeWorkflowVersions([published], null, {
    graphDigest: false,
    publishedBy: true,
  });
  expect(named.items[0]?.publishedBy).toEqual({
    id: published.publishedBy,
    displayName: 'Mira Builder',
  });
  expect(named.items[0]).not.toHaveProperty('graphDigest');
});

it('omits run summaries unless the credential permits run reads', () => {
  const record = workflow();
  const withSummary = {
    ...record,
    listSummary: {
      shape: { nodes: [], edges: [] },
      recentRuns: [
        { status: 'succeeded' as const, createdAt: '2026-08-20T12:00:00.000Z' },
      ],
    },
  };
  expect(
    serializeWorkflowList([withSummary], null, { recentRuns: false }).items[0]
      ?.listSummary,
  ).toEqual({ shape: { nodes: [], edges: [] } });
  expect(
    serializeWorkflowList([withSummary], null, { recentRuns: true }).items[0]
      ?.listSummary,
  ).toEqual(withSummary.listSummary);
});
