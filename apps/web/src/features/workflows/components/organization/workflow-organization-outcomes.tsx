import type {
  WorkflowOrganizationProjectionResponse,
  WorkflowOrganizationBulkItemOutcome,
} from '@pertexo/contracts';
import { organizationOutcomeText } from './organization-editing';

/** Ordered receipts explain this command, never replace current metadata. */
export function WorkflowOrganizationOutcomes({
  items,
  workflows,
}: Readonly<{
  items: readonly WorkflowOrganizationBulkItemOutcome[];
  workflows: readonly WorkflowOrganizationProjectionResponse[];
}>) {
  const names = new Map(
    workflows.map(({ workflow }) => [workflow.id, workflow.name]),
  );
  return (
    <section
      aria-label="Organization command outcomes"
      aria-live="polite"
      className="flex flex-col gap-2"
    >
      <p className="text-sm font-medium">Results in selection order</p>
      <ol className="flex flex-col gap-2 text-sm">
        {items.map((item, index) => (
          <li key={item.workflowId} className="flex flex-col gap-0.5">
            <span className="font-medium break-words">
              {names.get(item.workflowId) ??
                `Selected workflow ${String(index + 1)}`}
            </span>
            <span className="text-muted-foreground">
              {organizationOutcomeText(item)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        Results may be historical replays. Current organization is read
        separately.
      </p>
    </section>
  );
}
