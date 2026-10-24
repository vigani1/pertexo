import type {
  WorkflowGraphContract,
  WorkflowVersionResponse,
  WorkflowPromotionPreview,
} from '@pertexo/contracts';
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PublishChanges } from '@/features/workflow-publish/components/publication/publish-changes';
import { ReviewCandidate } from '@/features/workflow-publish/components/reviews/candidate';
import { summarizePublish } from '@/features/workflow-publish/model/publication/summary';
import { ConflictCompareDialog } from '@/features/workflow-editor/components/chrome/conflict-compare-dialog';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { PromotionReview } from '@/features/workflow-promotions/components/review';
import { VersionDiffSummary } from '@/features/workflow-settings/components/versions/diff-summary';
import { renderInRouter } from '../../../support/render-in-router';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base: WorkflowGraphContract = {
  nodes: ['a', 'b'].map((id) => ({
    id,
    label: `Step ${id}`,
    definition: { key: 'core.set', version: 1 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    position: { x: 0, y: 0 },
  })),
  edges: [],
  settings: {},
};
function version(graph: WorkflowGraphContract): WorkflowVersionResponse {
  return {
    id,
    workflowId: id,
    versionNumber: 1,
    graph,
    checksum: `wf:sha256:${'a'.repeat(64)}`,
    publishedAt: '2026-10-22T00:00:00Z',
  };
}
const changes: readonly [string, WorkflowGraphContract, RegExp][] = [
  [
    'step',
    {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'a' ? { ...n, label: 'Renamed step' } : n,
      ),
    },
    /Renamed step/u,
  ],
  [
    'links',
    {
      ...base,
      edges: [
        {
          id: 'link',
          source: { nodeId: 'a', port: 'out' },
          target: { nodeId: 'b', port: 'in' },
        },
      ],
    },
    /link|connect/iu,
  ],
  [
    'notes',
    {
      ...base,
      notes: [
        {
          id,
          text: '## Reviewed **note**',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 200 },
          color: 'teal',
        },
      ],
    },
    /Note: Reviewed note/u,
  ],
  [
    'settings',
    { ...base, settings: { maxRunDurationMs: 60_000 } },
    /workflow.*settings/iu,
  ],
  [
    'callable',
    {
      ...base,
      callable: {
        input: { type: 'string' },
        resultType: { type: 'string' },
        result: { kind: 'run_input', path: '$' },
      },
    },
    /callable contract/iu,
  ],
];
for (const [category, after, label] of changes) {
  it.each([
    'publish',
    'approval',
    'conflict',
    'promotion',
    'versions',
  ] as const)(
    `shows a ${category}-only change in %s review without opening JSON`,
    async (context) => {
      const store = createEditorStore({
        graph: after,
        etag: 'draft-1',
        revision: 1,
      });
      store.getState().reportConflict({
        local: after,
        remote: base,
        remoteEtag: 'draft-2',
        remoteRevision: 2,
      });
      const review: WorkflowPromotionPreview = {
        fingerprint: 'a'.repeat(64),
        sourceWorkspaceId: id,
        sourceWorkspaceName: 'Development',
        targetWorkspaceId: id,
        targetWorkspaceName: 'Production',
        mode: 'draft',
        requireApproval: false,
        compatible: true,
        requirements: [],
        workflows: [
          {
            sourceWorkflowId: id,
            sourceName: 'Orders',
            sourceVersionId: id,
            sourceVersionNumber: 1,
            sourceChecksum: version(base).checksum,
            targetWorkflowId: id,
            targetName: 'Orders',
            targetRevision: 1,
            targetPublishedVersionId: null,
            directChanges: false,
            proposedGraph: after,
            targetGraph: base,
          },
        ],
      };
      renderInRouter(
        context === 'publish' ? (
          <PublishChanges
            summary={summarizePublish(after, version(base))}
            state="ready"
          />
        ) : context === 'approval' ? (
          <ReviewCandidate graph={after} liveGraph={base} />
        ) : context === 'conflict' ? (
          <EditorStoreContext value={{ store }}>
            <ConflictCompareDialog open onOpenChange={() => undefined} />
          </EditorStoreContext>
        ) : context === 'promotion' ? (
          <PromotionReview
            review={review}
            acknowledged={[]}
            locked={false}
            onAcknowledge={() => undefined}
          />
        ) : (
          <VersionDiffSummary from={version(base)} to={version(after)} />
        ),
      );
      expect(
        (await screen.findAllByText(label)).some(
          (element) => element.closest('pre, textarea') === null,
        ),
      ).toBe(true);
      expect(
        screen.queryByText(/only step layout differs|No step changes/u),
      ).not.toBeInTheDocument();
    },
  );
}
