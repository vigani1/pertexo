import type { VariableUsageInput, VariableUsageScan } from './contract.js';
import {
  scanVariableUsage,
  type UsageSpending,
  type UsageWorkflow,
} from './usage-scan.js';

/** A workflow with no expressions costs a query and a parse, but no source budget. */
const MAX_WORKFLOWS_PER_PAGE = 25;

type UsageCursor = NonNullable<VariableUsageInput['after']>;

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
