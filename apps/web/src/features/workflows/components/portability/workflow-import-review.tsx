import { connectionFitsSlot } from '@pertexo/workflow-model';
import { connectionSlotKey } from '../../model/portability';
import { useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowImportPreviewResponse,
} from '@pertexo/contracts';
import type {
  PortableConnectionBinding,
  PortableConnectionSlot,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
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
import {
  describeConnectionRequirement,
  describeStep,
  familyWord,
  StepTile,
} from '@/features/catalog/presentation.public';
import { PortableGraphReview } from './portable-graph-review';
import { Disclosure } from '@/components/ui/disclosure';

type PortableNode = WorkflowPortableManifest['graph']['nodes'][number];

function stepName(node: PortableNode | undefined, fallback: string): string {
  if (node === undefined) return fallback;
  return node.label ?? describeStep(node.definition.key).name;
}

/**
 * The file's steps in words, each marked where it reaches outside Pertexo,
 * with every value of the file one fold away and never shortened.
 */
function ImportContents({
  manifest,
}: Readonly<{ manifest: WorkflowPortableManifest }>) {
  const nodes = manifest.graph.nodes;
  return (
    <section
      aria-label="What the file contains"
      className="flex flex-col gap-2"
    >
      <h3 className="text-sm font-semibold text-foreground">What’s inside</h3>
      <ol className="flex flex-col rounded-lg border border-border">
        {nodes.map((node) => {
          const step = describeStep(node.definition.key);
          return (
            <li
              key={node.id}
              className="flex items-center gap-3 border-t border-border px-3 py-2 first:border-t-0"
            >
              <StepTile step={step} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {stepName(node, step.name)}
                </span>
                <span className="block text-xs text-subtle-foreground">
                  {familyWord(step.family)}
                  {node.label === undefined ? '' : ` · ${step.name}`}
                </span>
              </span>
              {step.sideEffect === undefined ? null : (
                <span className="max-w-56 text-right text-xs text-warning">
                  {step.sideEffect
                    .replace(/^This /u, '')
                    .replace(/^\w/u, (letter) => letter.toUpperCase())}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <Disclosure
        summary="Everything in the file"
        className="text-xs text-muted-foreground"
        appearance={{ size: 'xs' }}
      >
        <div className="mt-2">
          <PortableGraphReview
            graph={manifest.graph}
            label="Complete imported graph"
          />
        </div>
      </Disclosure>
    </section>
  );
}

function WorkflowImportConnections({
  slots,
  nodes,
  bindings,
  optionalSlots,
  disabled,
  onChange,
  scope,
}: Readonly<{
  slots: readonly PortableConnectionSlot[];
  nodes: readonly PortableNode[];
  bindings: readonly PortableConnectionBinding[];
  optionalSlots: ReadonlySet<string>;
  disabled: boolean;
  onChange: (bindings: PortableConnectionBinding[]) => void;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
}>) {
  const { apiClient, userId, workspace } = scope;

  const canRead = workspace.capabilities.includes('connection:read');
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, userId, workspace.id),
    enabled: slots.length > 0 && canRead,
    staleTime: 0,
  });
  const bindingSelectionBlocked =
    disabled || connections.isFetching || connections.isError || !canRead;
  return (
    <section
      aria-label="Destination connection bindings"
      className="flex flex-col gap-3"
    >
      <h3 className="text-sm font-semibold text-foreground">
        Connections to use
      </h3>
      <p className="text-sm text-muted-foreground">
        The file never brings its own credentials. Choose one of this
        workspace’s connections for each step that needs one.
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
            connectionFitsSlot(connection, slot) &&
            connection.status === 'active',
        );
        const optional = optionalSlots.has(
          connectionSlotKey(slot.nodeId, slot.slot),
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
            label={stepName(
              nodes.find((node) => node.id === slot.nodeId),
              slot.nodeId,
            )}
            description={
              optional
                ? `${describeConnectionRequirement(slot.authType)}, optional: leave it empty for an API that needs no key.`
                : `${describeConnectionRequirement(slot.authType)}${choices.length === 0 && !connections.isFetching ? '. This workspace has none yet; add one in Connections.' : ''}`
            }
          >
            {(control) => (
              <Select
                value={selected}
                items={[
                  ...(optional
                    ? [{ value: null, label: 'No connection' }]
                    : []),
                  ...choices.map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                  })),
                ]}
                disabled={bindingSelectionBlocked}
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
                  <SelectValue
                    placeholder={
                      optional ? 'No connection' : 'Choose a connection'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {optional ? (
                    <SelectItem value={null}>No connection</SelectItem>
                  ) : null}
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

function WorkflowImportCompatibility({
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
          ? 'Compatible with this workspace. Importing creates an unpublished draft.'
          : 'This file doesn’t fit this workspace yet. Fix the issues below, then check again.'}
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

/** The reviewed graph, destination bindings and server compatibility readback. */
export function WorkflowImportReview({
  manifest,
  preview,
  bindings,
  optionalSlots,
  disabled,
  onBindingsChange,
  scope,
}: Readonly<{
  manifest: WorkflowPortableManifest | undefined;
  preview: WorkflowImportPreviewResponse | undefined;
  bindings: readonly PortableConnectionBinding[];
  optionalSlots: ReadonlySet<string>;
  disabled: boolean;
  onBindingsChange: (bindings: PortableConnectionBinding[]) => void;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
}>) {
  const { apiClient, userId, workspace } = scope;

  return (
    <>
      {manifest === undefined ? null : (
        <>
          <ImportContents manifest={manifest} />
          {manifest.connectionSlots.length === 0 ? null : (
            <WorkflowImportConnections
              slots={manifest.connectionSlots}
              nodes={manifest.graph.nodes}
              bindings={bindings}
              optionalSlots={optionalSlots}
              disabled={disabled}
              onChange={onBindingsChange}
              scope={{
                apiClient,
                userId,
                workspace,
              }}
            />
          )}
        </>
      )}
      {preview === undefined ? null : (
        <WorkflowImportCompatibility preview={preview} />
      )}
    </>
  );
}
