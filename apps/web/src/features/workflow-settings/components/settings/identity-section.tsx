import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { CopyField } from '../copy-field';
import { visibleSettingsData, type SettingsQuery } from '../settings-query';
import { SettingsQueryState, SettingsSection } from '../settings-section';

function Moment({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">
        <time dateTime={value}>{formatRelativeTime(value)}</time>
        <span className="block font-mono text-[0.72rem] text-subtle-foreground">
          {formatDateTime(value)}
        </span>
      </dd>
    </div>
  );
}

/** The workflow's name, its ID for support and APIs, and its age. */
export function IdentitySection({
  query,
}: Readonly<{ query: SettingsQuery<WorkflowSummary> }>) {
  const workflow = visibleSettingsData(query);
  return (
    <SettingsSection
      title="Identity"
      description="How this workflow is known. Renaming isn’t available yet."
    >
      <SettingsQueryState query={query} resource="This workflow" />
      {workflow === undefined ? null : (
        <dl className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Name</dt>
            <dd className="text-base font-semibold">{workflow.name}</dd>
          </div>
          <div className="sm:col-span-2">
            <CopyField
              label="Workflow ID"
              value={workflow.id}
              display={workflow.id}
              className="max-w-md"
            />
          </div>
          <Moment label="Created" value={workflow.createdAt} />
          <Moment label="Last updated" value={workflow.updatedAt} />
        </dl>
      )}
    </SettingsSection>
  );
}
