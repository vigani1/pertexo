import type {
  WorkflowGraphContract,
  WorkflowPromotionPreview,
  WorkflowVersionResponse,
} from '@pertexo/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConflictCompareDialog } from '@/features/workflow-editor/components/chrome/conflict-compare-dialog';
import { EditorStoreContext } from '@/features/workflow-editor/model/state/context';
import { createEditorStore } from '@/features/workflow-editor/model/state/workflow-editor.store';
import { PublishChanges } from '@/features/workflow-publish/components/publication/publish-changes';
import { ReviewCandidate } from '@/features/workflow-publish/components/reviews/candidate';
import { summarizePublish } from '@/features/workflow-publish/model/publication/summary';
import { PromotionReview } from '@/features/workflow-promotions/components/promotion-review';
import { VersionDiffSummary } from '@/features/workflow-settings/components/versions/diff-summary';
import { diffWorkflowGraphs } from '@/features/workflows/comparison.public';
import { renderInRouter } from '../../../support/render-in-router';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const step = (stepId: string, label: string, x = 0) => ({
  id: stepId,
  label,
  definition: { key: 'http.request', version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});

type Step = ReturnType<typeof step>;
type Edge = Readonly<{
  id: string;
  source: Readonly<{ nodeId: string; port: string }>;
  target: Readonly<{ nodeId: string; port: string }>;
}>;

const forEach = (
  stepId: string,
  label: string,
  nodes: readonly object[],
  edges: readonly Edge[] = [],
) => ({
  ...step(stepId, label),
  definition: { key: 'core.foreach', version: 1 },
  structured: {
    kind: 'for_each',
    maxIterations: 10,
    maxConcurrency: 1,
    body: {
      settings: {},
      nodes,
      edges,
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    },
  },
});

const graph = (nodes: readonly object[]) =>
  ({ nodes, edges: [], settings: {} }) as unknown as WorkflowGraphContract;

const shop: Step = step('shop', 'Call the shop');
const mail: Step = step('mail', 'Send the mail');
const link = (from: string, to: string): Edge => ({
  id: `${from}-${to}`,
  source: { nodeId: from, port: 'out' },
  target: { nodeId: to, port: 'in' },
});

function version(
  body: WorkflowGraphContract,
  versionNumber: number,
): WorkflowVersionResponse {
  return {
    id,
    workflowId: id,
    versionNumber,
    graph: body,
    checksum: `wf:sha256:${'a'.repeat(64)}`,
    publishedAt: '2026-10-22T00:00:00Z',
  };
}

const preview = (
  before: WorkflowGraphContract,
  after: WorkflowGraphContract,
): WorkflowPromotionPreview => ({
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
      sourceChecksum: `wf:sha256:${'a'.repeat(64)}`,
      targetWorkflowId: id,
      targetName: 'Orders',
      targetRevision: 1,
      targetPublishedVersionId: null,
      directChanges: false,
      proposedGraph: after,
      targetGraph: before,
    },
  ],
});

type Show = (
  before: WorkflowGraphContract,
  after: WorkflowGraphContract,
) => void;

/** Every screen that compares two graphs, each judged by what it shows. */
const SCREENS: Readonly<Record<string, Show>> = {
  'version compare': (before, after) => {
    renderInRouter(
      <VersionDiffSummary from={version(before, 1)} to={version(after, 2)} />,
    );
  },
  'promotion review': (before, after) => {
    renderInRouter(
      <PromotionReview
        review={preview(before, after)}
        acknowledged={[]}
        locked={false}
        onAcknowledge={() => undefined}
      />,
    );
  },
  'conflict compare': (before, after) => {
    const store = createEditorStore({
      graph: after,
      etag: 'draft-1',
      revision: 1,
    });
    store.getState().reportConflict({
      local: after,
      remote: before,
      remoteEtag: 'draft-2',
      remoteRevision: 2,
    });
    renderInRouter(
      <EditorStoreContext value={store}>
        <ConflictCompareDialog open onOpenChange={() => undefined} />
      </EditorStoreContext>,
    );
  },
  'publish review': (before, after) => {
    renderInRouter(
      <PublishChanges
        summary={summarizePublish(after, version(before, 1))}
        state="ready"
      />,
    );
  },
  'approval review': (before, after) => {
    renderInRouter(<ReviewCandidate graph={after} liveGraph={before} />);
  },
};

const empty = (nodes: readonly object[] = []) =>
  graph([forEach('loop', 'Each order', nodes)]);
const text = () => document.body.textContent;

describe.each(Object.entries(SCREENS))('%s', (_name, show) => {
  it('names a step added inside a For each, not the For each', async () => {
    show(empty(), empty([shop]));
    expect(
      (await screen.findAllByText(/Call the shop/u)).length,
    ).toBeGreaterThan(0);
    expect(text()).not.toMatch(/Each order\s*·\s*setup/u);
  });

  it('names a step removed from inside a For each', async () => {
    show(empty([shop]), empty());
    expect(
      (await screen.findAllByText(/Call the shop/u)).length,
    ).toBeGreaterThan(0);
  });

  it('names a step added in a For each inside a For each', async () => {
    show(
      empty([forEach('inner', 'Each line', [])]),
      empty([forEach('inner', 'Each line', [shop])]),
    );
    expect(
      (await screen.findAllByText(/Call the shop/u)).length,
    ).toBeGreaterThan(0);
    expect(text()).not.toMatch(/Each line\s*·\s*setup/u);
  });

  it('says what changed about a step inside a For each', async () => {
    show(empty([shop]), empty([{ ...shop, label: 'Call the store' }]));
    expect(
      (await screen.findAllByText(/Call the store/u)).length,
    ).toBeGreaterThan(0);
  });

  it('counts a link added inside a For each', async () => {
    show(
      empty([shop, mail]),
      graph([
        forEach('loop', 'Each order', [shop, mail], [link('shop', 'mail')]),
      ]),
    );
    expect(
      (await screen.findAllByText(/link|connect/iu)).length,
    ).toBeGreaterThan(0);
  });

  it('treats moving a step inside a For each as no change', () => {
    show(empty([shop]), empty([{ ...shop, position: { x: 90, y: 40 } }]));
    expect(text()).not.toMatch(/Call the shop\s*·/u);
    expect(screen.queryByText(/^Changed$/u)).toBeNull();
  });
});

describe('every compare counts the same', () => {
  const before = empty([shop]);
  const after = graph([
    forEach('loop', 'Each order', [
      shop,
      mail,
      forEach('inner', 'Each line', [step('deep', 'Deep step')]),
    ]),
  ]);

  it('finds three added steps at any depth, in both directions', () => {
    const forward = diffWorkflowGraphs(before, after);
    expect(forward.added.map(({ label }) => label)).toEqual([
      'Send the mail',
      'Each line',
      'Deep step',
    ]);
    expect(forward.changed).toEqual([]);
    const backward = diffWorkflowGraphs(after, before);
    expect(backward.removed.map(({ label }) => label)).toEqual([
      'Send the mail',
      'Each line',
      'Deep step',
    ]);
  });

  it('says a step moved into a For each changed, since it now runs once per item', () => {
    const outside = graph([shop, forEach('loop', 'Each order', [])]);
    const diff = diffWorkflowGraphs(outside, empty([shop]));
    expect(diff.changed).toEqual([
      {
        id: 'shop',
        label: 'Call the shop',
        detail: 'moved in or out of a For each',
      },
    ]);
    expect(diff.layoutOnly).toBe(false);
  });

  it('says a step moved out of a For each changed', () => {
    const outside = graph([shop, forEach('loop', 'Each order', [])]);
    const diff = diffWorkflowGraphs(empty([shop]), outside);
    expect(diff.lines.map(({ label }) => label)).toContain('Call the shop');
  });

  it('says a step moved between For eaches changed', () => {
    const first = graph([
      forEach('loop', 'Each order', [shop]),
      forEach('other', 'Each line', []),
    ]);
    const second = graph([
      forEach('loop', 'Each order', []),
      forEach('other', 'Each line', [shop]),
    ]);
    const diff = diffWorkflowGraphs(first, second);
    expect(diff.lines.map(({ label }) => label)).toContain('Call the shop');
  });
});
