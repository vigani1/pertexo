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
} from './contract.js';

const MAX_SOURCES_PER_PAGE = 100;
const MAX_SOURCE_BYTES_PER_PAGE = 65_536;

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

/**
 * One bounded page of one workflow's references to a name. Expression analysis
 * costs real time, so a page stops at its source and byte budgets, and resumes
 * by position only while the stamp shows the workflow's graphs are unchanged.
 */
export function scanVariableUsage(
  workflow: UsageWorkflow,
  input: Pick<VariableUsageInput, 'name' | 'limit' | 'after'>,
): VariableUsagePage {
  const stamp = usageDigest([workflow.draftRevision, workflow.versionId]);
  const offset = input.after?.offset ?? 0;
  if (
    offset > 0 &&
    (input.after?.workflowId !== workflow.id || input.after.stamp !== stamp)
  )
    throw new WorkspaceVariableUsageChangedError();
  const items: VariableUsagePage['items'][number][] = [];
  let incomplete = false,
    scanned = 0,
    bytes = 0;
  for (const { stage, ordinal, entry } of stagedSources(workflow)) {
    if (ordinal < offset) continue;
    const budgetSpent =
      items.length >= input.limit ||
      scanned >= MAX_SOURCES_PER_PAGE ||
      (scanned > 0 && bytes + entry.costBytes > MAX_SOURCE_BYTES_PER_PAGE);
    if (budgetSpent)
      return {
        items,
        incomplete,
        next: { workflowId: workflow.id, offset: ordinal, stamp },
      };
    scanned++;
    bytes += entry.costBytes;
    const inspected = inspectWorkflowVariableSource(entry);
    incomplete ||= inspected.incomplete;
    const { reference } = inspected;
    if (
      reference !== null &&
      (reference.dynamic || reference.names.includes(input.name))
    )
      items.push({
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
      });
  }
  return {
    items,
    incomplete,
    next: workflow.hasMore
      ? { workflowId: workflow.id, offset: 0, stamp }
      : null,
  };
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
