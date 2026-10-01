import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type {
  PortableConnectionBinding,
  PortableConnectionSlot,
  WorkflowImportPreviewResponse,
} from '@pertexo/contracts/schemas/workflow-portability';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import type { ApiClient } from '@/lib/api/client';

export function WorkflowImportConnections({
  apiClient,
  userId,
  workspace,
  slots,
  bindings,
  disabled,
  onChange,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  slots: readonly PortableConnectionSlot[];
  bindings: readonly PortableConnectionBinding[];
  disabled: boolean;
  onChange: (bindings: PortableConnectionBinding[]) => void;
}>) {
  const canRead = workspace.capabilities.includes('connection:read');
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, userId, workspace.id),
    enabled: slots.length > 0 && canRead,
    staleTime: 0,
  });
  return (
    <section
      aria-label="Destination connection bindings"
      className="flex flex-col gap-3"
    >
      <h3 className="font-heading text-sm">Choose destination connections</h3>
      <p className="text-sm text-muted-foreground">
        {slots.length === 0
          ? 'This file declares no connection slots.'
          : 'Choose every slot explicitly. Source connection names and IDs are not reused.'}
      </p>
      {!canRead && slots.length > 0 ? (
        <Notice tone="warning">
          You need permission to read destination connections before binding
          this file.
        </Notice>
      ) : null}
      {connections.isFetching ? (
        <p role="status">Reading current destination connections…</p>
      ) : null}
      {connections.error === null ? null : (
        <Notice tone="destructive">
          Couldn’t read destination connections.{' '}
          <Button variant="link" onClick={() => void connections.refetch()}>
            Retry
          </Button>
        </Notice>
      )}
      {slots.map((slot, index) => {
        const choices = (connections.data?.items ?? []).filter(
          (connection) =>
            connection.providerKey === slot.providerKey &&
            connection.authType === slot.authType &&
            connection.status === 'active',
        );
        const selected =
          bindings.find(
            (binding) =>
              binding.nodeId === slot.nodeId && binding.slot === slot.slot,
          )?.connectionId ?? null;
        return (
          <LabelledField
            key={JSON.stringify([slot.nodeId, slot.slot])}
            id={`portable-slot-${String(index)}`}
            label={`${slot.nodeId} · ${slot.slot}`}
            description={`${slot.providerKey} / ${slot.authType}${choices.length === 0 && !connections.isFetching ? ' — no eligible connections' : ''}`}
          >
            {(control) => (
              <Select
                value={selected}
                items={choices.map((connection) => ({
                  value: connection.id,
                  label: connection.name,
                }))}
                disabled={
                  disabled ||
                  connections.isFetching ||
                  connections.isError ||
                  !canRead
                }
                onValueChange={(value: string | null) => {
                  onChange([
                    ...bindings.filter(
                      (binding) =>
                        binding.nodeId !== slot.nodeId ||
                        binding.slot !== slot.slot,
                    ),
                    ...(value === null
                      ? []
                      : [
                          {
                            nodeId: slot.nodeId,
                            slot: slot.slot,
                            connectionId: value,
                          },
                        ]),
                  ]);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue placeholder="Choose a connection" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </LabelledField>
        );
      })}
    </section>
  );
}

export function WorkflowImportCompatibility({
  preview,
}: Readonly<{ preview: WorkflowImportPreviewResponse }>) {
  const issues = new Map(
    preview.issues.map((issue) => [
      JSON.stringify([issue.code, issue.path, issue.message]),
      issue,
    ]),
  );
  return (
    <section
      aria-label="Import compatibility preview"
      aria-live="polite"
      className="flex flex-col gap-2"
    >
      <Notice tone={preview.compatible ? 'success' : 'warning'}>
        {preview.compatible
          ? 'Compatible with this workspace. Import creates an unpublished draft, not a runnable publication.'
          : 'This file is incompatible. Resolve the issues before importing.'}
      </Notice>
      {[...issues].map(([key, issue]) => (
        <p key={key} className="text-sm">
          <span className="font-mono text-xs">{issue.path}</span>{' '}
          {issue.message}
        </p>
      ))}
      {preview.truncated ? (
        <p className="text-sm text-warning">
          Additional issues were omitted. The import remains blocked until the
          complete check passes.
        </p>
      ) : null}
    </section>
  );
}
