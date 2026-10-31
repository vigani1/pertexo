import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  inspectWorkflowVariableSource,
  workflowVariableSources,
} from '@pertexo/workflow-model/server';
import { createHash } from 'node:crypto';

import {
  WorkspaceVariableUsageChangedError,
  type VariableUsageInput,
  type VariableUsagePage,
  type VariableUsageScan,
} from './contract.js';

const MAX_SOURCES_PER_PAGE = 100;
const MAX_SOURCE_BYTES_PER_PAGE = 65_536;
/** A workflow with no expressions costs a query and a parse, but no source budget. */
const MAX_WORKFLOWS_PER_PAGE = 25;

/** What this page has used so far, across its workflows. */
interface UsageSpending {
  sources: number;
  bytes: number;
}

type UsageWorkflow = Readonly<{
  id: string;
  name: string;
  lifecycleStatus: string;
  draftRevision: number | null;
  draftGraph: unknown;
  versionId: string | null;
  publishedGraph: unknown;
  hasMore: boolean;
}>;

type UsageCursor = NonNullable<VariableUsageInput['after']>;
type UsageReference = NonNullable<
  ReturnType<typeof inspectWorkflowVariableSource>['reference']
>;

/**
 * One bounded page of references to a name. It reads one workflow at a time, so
 * only one graph is in memory, and stops at the page's budgets, its item limit
 * or its workflow cap, whichever comes first.
 */
export async function walkVariableUsage(
  input: Pick<VariableUsageInput, 'name' | 'limit' | 'after'>,
  readWorkflowAfter: (
    after: UsageCursor | undefined,
  ) => Promise<UsageWorkflow | undefined>,
): Promise<VariableUsageScan> {
  const spent: UsageSpending = { sources: 0, bytes: 0 };
  const items: VariableUsageScan['items'][number][] = [];
  let incomplete = false;
  let after = input.after;
  for (let read = 1; ; read++) {
    const workflow = await readWorkflowAfter(after);
    if (workflow === undefined) return { items, incomplete, next: null };
    const scan = scanVariableUsage(
      workflow,
      {
        name: input.name,
        limit: input.limit - items.length,
        ...(after === undefined ? {} : { after }),
      },
      spent,
    );
    items.push(...scan.items);
    incomplete ||= scan.incomplete;
    const { next } = scan;
    const passedWorkflow =
      next?.workflowId === workflow.id && next.offset === 0;
    if (next === null || !passedWorkflow || read === MAX_WORKFLOWS_PER_PAGE)
      return { items, incomplete, next };
    after = next;
  }
}

/**
 * One workflow's references to a name. Expression analysis costs real time, so
 * this stops at the page's budgets, and a later page resumes by position only
 * while the stamp shows the workflow's graphs are unchanged.
 */
export function scanVariableUsage(
  workflow: UsageWorkflow,
  input: Pick<VariableUsageInput, 'name' | 'limit' | 'after'>,
  spent: UsageSpending = { sources: 0, bytes: 0 },
): VariableUsageScan {
  const stamp = usageDigest([workflow.draftRevision, workflow.versionId]);
  const offset = input.after?.offset ?? 0;
  if (offset > 0 && !cursorFits(input.after, workflow.id, stamp))
    throw new WorkspaceVariableUsageChangedError();
  const items: VariableUsagePage['items'][number][] = [];
  let incomplete = false;
  for (const { stage, ordinal, entry } of stagedSources(workflow)) {
    if (ordinal < offset) continue;
    if (
      pageIsFull(spent, entry.costBytes) ||
      (spent.sources > 0 && items.length >= input.limit)
    )
      return {
        items,
        incomplete,
        // Offset 0 means a workflow was passed, so one not yet started resumes
        // from the workflow before it. Spending means there was one.
        next:
          ordinal === 0
            ? (input.after ?? null)
            : { workflowId: workflow.id, offset: ordinal, stamp },
      };
    spent.sources++;
    spent.bytes += entry.costBytes;
    const inspected = inspectWorkflowVariableSource(entry);
    incomplete ||= inspected.incomplete;
    const { reference } = inspected;
    if (
      reference !== null &&
      (reference.dynamic || reference.names.includes(input.name))
    )
      items.push(usageItem(workflow, stage, ordinal, reference));
  }
  return {
    items,
    incomplete,
    next: workflow.hasMore
      ? { workflowId: workflow.id, offset: 0, stamp }
      : null,
  };
}

function cursorFits(
  cursor: VariableUsageInput['after'],
  workflowId: string,
  stamp: string,
): boolean {
  return cursor?.workflowId === workflowId && cursor.stamp === stamp;
}

function usageItem(
  workflow: UsageWorkflow,
  stage: 'draft' | 'published',
  ordinal: number,
  reference: UsageReference,
): VariableUsagePage['items'][number] {
  return {
    id: usageDigest([
      stage,
      stage === 'draft' ? workflow.draftRevision : workflow.versionId,
      ordinal,
    ]),
    workflowId: workflow.id,
    workflowName: workflow.name.slice(0, 160),
    archived: workflow.lifecycleStatus === 'archived',
    stage,
    nodeId: reference.nodeId,
    label: reference.label,
    input: reference.input,
    kind: reference.dynamic ? 'dynamic' : 'direct',
  };
}

/** A page's first source always runs, whatever it costs. */
function pageIsFull(spent: UsageSpending, costBytes: number): boolean {
  return (
    spent.sources >= MAX_SOURCES_PER_PAGE ||
    (spent.sources > 0 && spent.bytes + costBytes > MAX_SOURCE_BYTES_PER_PAGE)
  );
}

/** Every source of the draft, then of the publication, numbered across both. */
function* stagedSources(workflow: UsageWorkflow) {
  let ordinal = 0;
  for (const [stage, graph] of [
    ['draft', workflow.draftGraph],
    ['published', workflow.publishedGraph],
  ] as const) {
    if (graph === null) continue;
    for (const entry of workflowVariableSources(parseWorkflowGraphDraft(graph)))
      yield { stage, ordinal: ordinal++, entry };
  }
}

function usageDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
