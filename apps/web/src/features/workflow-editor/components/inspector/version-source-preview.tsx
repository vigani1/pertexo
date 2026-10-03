import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { CopyButton } from '@/components/ui/copy-button';
import { Notice } from '@/components/ui/notice';

/** Immutable response source, not a pin or an executable-eligibility projection. */
export function VersionSourcePreview({
  version,
}: Readonly<{ version: WorkflowVersionResponse }>) {
  const callable =
    version.schemaVersion === 2 ? version.graph.callable : undefined;
  return (
    <section
      aria-label="Inspected version source"
      className="flex min-w-0 flex-col gap-3"
    >
      <Notice title="Source only — eligibility unverified">
        Reading or copying this source does not change your pin, verify
        compatibility or authorize execution. The callable contract identity is
        not supplied by this response. Native publishing and execution remain
        unavailable.
      </Notice>
      <dl className="flex min-w-0 flex-col gap-3 text-sm">
        <SourceValue
          label="Workflow ID"
          value={version.workflowId}
          copyLabel="Copy source workflow ID"
        />
        <SourceValue
          label="Version ID"
          value={version.id}
          copyLabel="Copy source version ID"
        />
        <SourceValue
          label="Version checksum"
          value={version.checksum}
          copyLabel="Copy source version checksum"
        />
        <div>
          <dt className="text-muted-foreground">Published at</dt>
          <dd>
            <time dateTime={version.publishedAt}>{version.publishedAt}</time>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Source schema</dt>
          <dd>Graph V{version.schemaVersion}</dd>
        </div>
      </dl>
      {callable === undefined ? (
        <Notice>
          This source has no callable declaration. It is not offered as an
          executable Call target.
        </Notice>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Callable declaration present. These are source descriptors, not a
            compatibility or readiness check.
          </p>
          <Descriptor
            label="Callable input declaration"
            value={callable.input}
          />
          <Descriptor
            label="Callable result declaration"
            value={callable.result}
          />
        </>
      )}
    </section>
  );
}

function SourceValue({
  label,
  value,
  copyLabel,
}: Readonly<{ label: string; value: string; copyLabel: string }>) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
        <CopyButton label={copyLabel} value={value} />
      </dd>
    </div>
  );
}

function Descriptor({
  label,
  value,
}: Readonly<{ label: string; value: unknown }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{label}</h3>
      <pre
        aria-label={label}
        className="recessed-control max-h-48 overflow-auto rounded-md border p-3 text-xs"
      >
        <code>{JSON.stringify(value, null, 2)}</code>
      </pre>
    </div>
  );
}
