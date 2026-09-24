import type {
  WorkflowListQuery,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { StatusTone } from '@/components/ui/status';
import { describeWorkflowState } from './workflow-state';

export type WorkflowView = 'active' | 'archived' | 'all';
export type WorkflowSort = 'updated' | 'created';
export type WorkflowListOrder = NonNullable<WorkflowListQuery['order']>;

/** URL state for the list: every key is optional and defaults are omitted. */
export type WorkflowListSearch = Readonly<{
  create?: true;
  view?: Exclude<WorkflowView, 'active'>;
  sort?: Exclude<WorkflowSort, 'updated'>;
}>;

export const WORKFLOW_ORDER_BY_SORT: Readonly<
  Record<WorkflowSort, WorkflowListOrder>
> = { updated: 'updated_desc', created: 'created_asc' };

/** Tolerant search parsing: unknown or malformed values fall back to defaults. */
export function parseWorkflowListSearch(search: unknown): WorkflowListSearch {
  const read = (name: string): unknown =>
    typeof search === 'object' && search !== null
      ? Reflect.get(search, name)
      : undefined;
  const create = read('create');
  const view = read('view');
  const sort = read('sort');
  return {
    ...(create === true || create === 'true' || create === 1 || create === '1'
      ? { create: true as const }
      : {}),
    ...(view === 'archived' || view === 'all' ? { view } : {}),
    ...(sort === 'created' ? { sort } : {}),
  };
}

/** Applies a change to the list's URL state, omitting default values. */
export function updateWorkflowListSearch(
  current: WorkflowListSearch,
  change: Readonly<{
    create?: boolean;
    view?: WorkflowView;
    sort?: WorkflowSort;
  }>,
): WorkflowListSearch {
  const create = change.create ?? current.create === true;
  const view = change.view ?? current.view ?? 'active';
  const sort = change.sort ?? current.sort ?? 'updated';
  return {
    ...(create ? { create: true as const } : {}),
    ...(view === 'active' ? {} : { view }),
    ...(sort === 'updated' ? {} : { sort }),
  };
}

function matchesWorkflowView(
  workflow: Pick<WorkflowSummary, 'lifecycleStatus'>,
  view: WorkflowView,
): boolean {
  if (view === 'all') return true;
  return (workflow.lifecycleStatus === 'archived') === (view === 'archived');
}

/** Client-side filter over the loaded pages: view, then a name substring. */
export function filterWorkflows(
  workflows: readonly WorkflowSummary[],
  filter: Readonly<{ view: WorkflowView; query: string }>,
): readonly WorkflowSummary[] {
  const needle = filter.query.trim().toLocaleLowerCase();
  return workflows.filter(
    (workflow) =>
      matchesWorkflowView(workflow, filter.view) &&
      (needle === '' || workflow.name.toLocaleLowerCase().includes(needle)),
  );
}

export function countWorkflowViews(
  workflows: readonly Pick<WorkflowSummary, 'lifecycleStatus'>[],
): Readonly<Record<WorkflowView, number>> {
  const archived = workflows.filter(
    (workflow) => workflow.lifecycleStatus === 'archived',
  ).length;
  return {
    active: workflows.length - archived,
    archived,
    all: workflows.length,
  };
}

const STATE_WORDS: ReadonlyMap<string, Readonly<[string, string]>> = new Map([
  ['Live', ['live', 'live']],
  ['Starting', ['starting', 'starting']],
  ['Stopping', ['stopping', 'stopping']],
  ['Degraded', ['degraded', 'degraded']],
  ['Error', ['with an error', 'with errors']],
  ['Draft', ['draft', 'drafts']],
]);

export type WorkflowStateCount = Readonly<{
  label: string;
  tone: StatusTone;
  count: number;
}>;

/**
 * Counts of non-archived workflows by state for the header line, e.g.
 * "9 live", "2 drafts". Archived workflows are counted by the view toggle.
 */
export function countWorkflowStates(
  workflows: readonly WorkflowSummary[],
): readonly WorkflowStateCount[] {
  const counts = new Map<string, WorkflowStateCount>();
  for (const workflow of workflows) {
    const state = describeWorkflowState(workflow);
    const words = STATE_WORDS.get(state.label);
    if (workflow.lifecycleStatus === 'archived' || words === undefined)
      continue;
    const count = (counts.get(state.label)?.count ?? 0) + 1;
    counts.set(state.label, {
      tone: state.tone,
      count,
      label: count === 1 ? words[0] : words[1],
    });
  }
  return [...STATE_WORDS.keys()].flatMap((label) => {
    const entry = counts.get(label);
    return entry === undefined ? [] : [entry];
  });
}
