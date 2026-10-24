import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type {
  WorkflowVersionResponse,
  WorkflowVersionsResponse,
} from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  workflowCallConfigSchema,
  type CallableType,
  type WorkflowCallConfig,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { FieldDescription, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import {
  callTargetVersionsQueryOptions,
  callPinnedVersionQueryOptions,
  type CallTargetScope,
} from '../../../data/call-targets.queries';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import type { WorkflowNode } from '../../../model/graph/scopes';
import { ChoiceSelect } from './choice-select';

/** Selection is an explicit draft edit. New publications never rewrite its pin. */
export function CallTargetField({
  node,
  form,
  scope,
}: Readonly<{
  node: WorkflowNode;
  form: NodeFormApi;
  scope: CallTargetScope;
}>) {
  const parsed = workflowCallConfigSchema.safeParse(node.config);
  const pin = parsed.success ? parsed.data.target : undefined;
  const [browsingTarget, setBrowsingTarget] = useState<string | null>(null);
  const targetId = browsingTarget ?? pin?.workflowId ?? null;
  const versions = useInfiniteQuery(
    callTargetVersionsQueryOptions(scope, targetId),
  );
  const pinnedVersion = useQuery(callPinnedVersionQueryOptions(scope, pin));
  const { targets, selected, selectedVersionId, upgrade } =
    callVersionSelection(
      versions.data?.pages.flatMap((page) => page.items) ?? [],
      pinnedVersion.data,
      pin,
      targetId,
    );
  function chooseVersion(versionId: string | null) {
    const version = targets.find((candidate) => candidate.id === versionId);
    if (version === undefined) return;
    form.commit(
      {
        config: {
          target: {
            workflowId: version.workflowId,
            workflowVersionId: version.id,
            executableChecksum: version.checksum,
          },
        },
      },
      `${node.id}:target:${version.id}`,
    );
    setBrowsingTarget(null);
  }
  return (
    <div className="flex flex-col gap-3">
      <ChildWorkflowField
        scope={scope}
        pin={pin}
        targetId={targetId}
        editable={form.editable}
        nodeId={node.id}
        onChange={setBrowsingTarget}
      />
      {targetId === null ? null : (
        <LabelledField
          id={fieldControlId(node.id, 'targetVersion')}
          label="Published version"
          description={versionDiscoveryDescription(versions, targets)}
        >
          {(control) => (
            <ChoiceSelect
              {...control}
              describedBy={control['aria-describedby']}
              value={selectedVersionId}
              disabled={!form.editable || versions.isPending}
              onChange={chooseVersion}
              choices={[
                { value: null, label: 'Choose an exact callable version' },
                ...targets.map((version) => ({
                  value: version.id,
                  label: `Version ${String(version.versionNumber)}`,
                })),
              ]}
            />
          )}
        </LabelledField>
      )}
      {targetId === null ? null : (
        <>
          <QueryView query={versions} resource="Versions" loading={null} />
          <LoadMore
            subject="versions"
            label="Load more versions"
            hasNextPage={versions.hasNextPage}
            loading={versions.isFetchingNextPage}
            failed={versions.isFetchNextPageError}
            onLoadMore={() => void versions.fetchNextPage()}
          />
        </>
      )}
      <QueryView
        query={pinnedVersion}
        resource="The pinned version"
        loading={null}
      />
      {pin === undefined ? null : (
        <p className="text-xs text-subtle-foreground">
          Pinned to{' '}
          {selected === undefined
            ? pin.workflowVersionId
            : `version ${String(selected.versionNumber)}`}
          . Changes to the child do not change this Call.
        </p>
      )}
      {upgrade === undefined ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={!form.editable}
          onClick={() => {
            chooseVersion(upgrade.id);
          }}
        >
          Upgrade to version {upgrade.versionNumber}
        </Button>
      )}
      <CallContractSummary version={selected} />
      <FieldDescription>
        Map the child’s input on the Inputs tab. This step waits for its
        validated result; run the parent workflow to test the Call.
      </FieldDescription>
    </div>
  );
}

/** Keep workflow-discovery failures independent of the retained version pin. */
function ChildWorkflowField({
  scope,
  pin,
  targetId,
  editable,
  nodeId,
  onChange,
}: Readonly<{
  scope: CallTargetScope;
  pin: WorkflowCallConfig['target'] | undefined;
  targetId: string | null;
  editable: boolean;
  nodeId: string;
  onChange: (workflowId: string | null) => void;
}>) {
  const workflows = useInfiniteQuery(
    workflowsInfiniteQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
    ),
  );
  const discovered = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const choices = discovered.filter(
    (workflow) =>
      workflow.id !== scope.workflowId &&
      workflow.lifecycleStatus === 'active' &&
      workflow.publishedVersionId !== null,
  );
  const pinnedWorkflow = discovered.find(
    (workflow) => workflow.id === pin?.workflowId,
  );
  const pinnedChoice =
    pin === undefined ||
    choices.some((workflow) => workflow.id === pin.workflowId)
      ? []
      : [
          {
            value: pin.workflowId,
            label:
              pinnedWorkflow === undefined
                ? 'Pinned workflow'
                : `${pinnedWorkflow.name} (archived)`,
          },
        ];
  return (
    <>
      <LabelledField
        id={fieldControlId(nodeId, 'target')}
        label="Child workflow"
        description="Choose a callable workflow in this workspace. Its exact version stays pinned until you change it."
      >
        {(control) => (
          <ChoiceSelect
            {...control}
            describedBy={control['aria-describedby']}
            value={targetId}
            disabled={!editable || workflows.isPending}
            choices={[
              { value: null, label: 'Choose a published workflow' },
              ...pinnedChoice,
              ...choices.map((workflow) => ({
                value: workflow.id,
                label: workflow.name,
              })),
            ]}
            onChange={onChange}
          />
        )}
      </LabelledField>
      <LoadMore
        subject="workflows"
        label="Load more workflows"
        hasNextPage={workflows.hasNextPage}
        loading={workflows.isFetchingNextPage}
        failed={workflows.isFetchNextPageError}
        onLoadMore={() => void workflows.fetchNextPage()}
      />
      <QueryView query={workflows} resource="Workflows" loading={null} />
      {pinnedWorkflow?.lifecycleStatus === 'archived' ? (
        <Notice tone="warning">
          This child is archived. New Calls will fail until it is restored.
        </Notice>
      ) : null}
    </>
  );
}

/** Discovery can add choices; only an explicit edit changes the exact pin. */
function callVersionSelection(
  versions: readonly WorkflowVersionResponse[],
  pinnedVersion: WorkflowVersionResponse | undefined,
  pin: WorkflowCallConfig['target'] | undefined,
  targetId: string | null,
) {
  const discovered = versions.filter(
    (version) => version.graph.callable !== undefined,
  );
  const selected =
    discovered.find((version) => version.id === pin?.workflowVersionId) ??
    pinnedVersion;
  const sameTarget = targetId === pin?.workflowId;
  const targets =
    sameTarget &&
    selected !== undefined &&
    !discovered.some((version) => version.id === selected.id)
      ? [...discovered, selected]
      : discovered;
  const latest = discovered.reduce<WorkflowVersionResponse | undefined>(
    (current, version) =>
      current === undefined || version.versionNumber > current.versionNumber
        ? version
        : current,
    undefined,
  );
  return {
    targets,
    selected,
    selectedVersionId: sameTarget ? pin.workflowVersionId : null,
    upgrade:
      sameTarget &&
      selected !== undefined &&
      latest !== undefined &&
      latest.versionNumber > selected.versionNumber
        ? latest
        : undefined,
  };
}

type VersionDiscovery = UseInfiniteQueryResult<
  InfiniteData<WorkflowVersionsResponse>
>;

function versionDiscoveryDescription(
  query: VersionDiscovery,
  targets: readonly WorkflowVersionResponse[],
): ReactNode {
  if (query.isPending || query.isError || targets.length > 0) return undefined;
  return query.hasNextPage
    ? 'No callable versions loaded yet. Load more versions to continue.'
    : 'This workflow has no published callable contract. Add a contract and publish it first.';
}

function CallContractSummary({
  version,
}: Readonly<{ version: WorkflowVersionResponse | undefined }>) {
  const contract = version?.graph.callable;
  if (contract === undefined) return null;
  return (
    <dl className="space-y-2 text-xs">
      <div>
        <dt className="font-medium">Child input</dt>
        <dd className="text-subtle-foreground">{typeLabel(contract.input)}</dd>
      </div>
      <div>
        <dt className="font-medium">Child result</dt>
        <dd className="text-subtle-foreground">
          {typeLabel(contract.resultType)}
        </dd>
      </div>
    </dl>
  );
}

function typeLabel(type: CallableType): string {
  switch (type.type) {
    case 'array':
      return `Array of ${type.items.type}, up to ${String(type.maxItems)} items`;
    case 'object':
      return type.properties.length === 0
        ? 'Closed object with no properties'
        : `Closed object: ${type.properties
            .slice(0, 5)
            .map(
              (property) =>
                `${property.name} (${property.valueType.type}, ${property.required ? 'required' : 'optional'})`,
            )
            .join(
              '; ',
            )}${type.properties.length > 5 ? `; ${String(type.properties.length - 5)} more properties` : ''}`;
    case 'boolean':
    case 'null':
    case 'number':
    case 'string':
    default:
      return type.type;
  }
}
