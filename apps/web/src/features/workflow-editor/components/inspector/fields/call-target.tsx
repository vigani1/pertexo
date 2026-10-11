import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  workflowCallConfigSchema,
  type CallableType,
} from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import { FieldDescription, LabelledField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import {
  callTargetVersionsQueryOptions,
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
  const workflows = useInfiniteQuery(
    workflowsInfiniteQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
    ),
  );
  const versions = useQuery(callTargetVersionsQueryOptions(scope, targetId));
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
  const targets = versions.data ?? [];
  const selected = targets.find(
    (version) => version.id === pin?.workflowVersionId,
  );
  const latest = targets.reduce<typeof selected>(
    (current, version) =>
      current === undefined || version.versionNumber > current.versionNumber
        ? version
        : current,
    undefined,
  );
  const sameTarget = targetId === pin?.workflowId;
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
      <LabelledField
        id={fieldControlId(node.id, 'target')}
        label="Child workflow"
        description="Choose a callable workflow in this workspace. Its exact version stays pinned until you change it."
      >
        {(control) => (
          <ChoiceSelect
            {...control}
            describedBy={control['aria-describedby']}
            value={targetId}
            disabled={!form.editable || workflows.isPending}
            choices={[
              { value: null, label: 'Choose a published workflow' },
              ...pinnedChoice,
              ...choices.map((workflow) => ({
                value: workflow.id,
                label: workflow.name,
              })),
            ]}
            onChange={setBrowsingTarget}
          />
        )}
      </LabelledField>
      {workflows.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={workflows.isFetchingNextPage}
          onClick={() => {
            void workflows.fetchNextPage();
          }}
        >
          Load more workflows
        </Button>
      ) : null}
      {workflows.isError ? (
        <Notice tone="destructive">
          Workflow discovery failed.{' '}
          <Button
            variant="link"
            onClick={() => {
              void workflows.refetch();
            }}
          >
            Try again
          </Button>
        </Notice>
      ) : null}
      {targetId === null ? null : (
        <LabelledField
          id={fieldControlId(node.id, 'targetVersion')}
          label="Published version"
          description={
            versions.isError ? (
              <>
                Versions could not be loaded.{' '}
                <Button
                  variant="link"
                  onClick={() => {
                    void versions.refetch();
                  }}
                >
                  Try again
                </Button>
              </>
            ) : targets.length === 0 && !versions.isPending ? (
              'This workflow has no published callable contract. Add a contract and publish it first.'
            ) : undefined
          }
        >
          {(control) => (
            <ChoiceSelect
              {...control}
              describedBy={control['aria-describedby']}
              value={sameTarget ? pin.workflowVersionId : null}
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
      {pin === undefined ? null : (
        <p className="text-xs text-subtle-foreground">
          Pinned to{' '}
          {selected === undefined
            ? pin.workflowVersionId
            : `version ${String(selected.versionNumber)}`}
          . Changes to the child do not change this Call.
        </p>
      )}
      {sameTarget &&
      latest !== undefined &&
      latest.id !== pin.workflowVersionId ? (
        <Button
          variant="outline"
          size="sm"
          disabled={!form.editable}
          onClick={() => {
            chooseVersion(latest.id);
          }}
        >
          Upgrade to version {latest.versionNumber}
        </Button>
      ) : null}
      {pinnedWorkflow?.lifecycleStatus === 'archived' ? (
        <Notice tone="warning">
          This child is archived. New Calls will fail until it is restored.
        </Notice>
      ) : null}
      {selected?.graph.callable === undefined ? null : (
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="font-medium">Child input</dt>
            <dd className="text-subtle-foreground">
              {typeLabel(selected.graph.callable.input)}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Child result</dt>
            <dd className="text-subtle-foreground">
              {typeLabel(selected.graph.callable.resultType)}
            </dd>
          </div>
        </dl>
      )}
      <FieldDescription>
        Map the child’s input on the Inputs tab. This step waits for its
        validated result; run the parent workflow to test the Call.
      </FieldDescription>
    </div>
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
    default:
      return type.type;
  }
}
