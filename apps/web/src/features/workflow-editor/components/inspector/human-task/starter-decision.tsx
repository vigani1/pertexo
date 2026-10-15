import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskAudience } from '@pertexo/workflow-model';
import {
  audienceInspectionQueryOptions,
  type TaskScope,
} from '@/features/pending-tasks/queries.public';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import type { NodeFormApi } from '../../../model/inspector/node-form';

export function StarterDecisionField({
  scope,
  form,
  audience,
  allowed,
}: Readonly<{
  scope: TaskScope;
  form: NodeFormApi;
  audience: TaskAudience;
  allowed: boolean;
}>) {
  const descriptionId = useId();
  const inspection = useQuery({
    ...audienceInspectionQueryOptions(scope, audience),
    enabled: form.editable,
  });
  return (
    <>
      <Field data-disabled={!form.editable || undefined}>
        <FieldLabel className="flex items-center gap-2">
          <Checkbox
            checked={allowed}
            disabled={!form.editable}
            aria-describedby={descriptionId}
            onCheckedChange={(checked) => {
              form.commit(
                (node) => ({
                  config: { ...node.config, allowStarterToDecide: checked },
                }),
                `${form.nodeId}:task:starter`,
              );
            }}
          />
          Allow the person who started the run to decide
        </FieldLabel>
        <FieldDescription id={descriptionId}>
          Off by default so a different person reviews the request. The starter
          must still belong to the chosen audience.
        </FieldDescription>
      </Field>
      {form.editable && inspection.isError ? (
        <ReadFailure
          resource="Approval audience"
          error={inspection.error}
          showing={inspection.data !== undefined}
          retrying={inspection.isFetching}
          updatedAt={inspection.dataUpdatedAt}
          onRetry={() => void inspection.refetch()}
        />
      ) : null}
      {form.editable &&
      !allowed &&
      inspection.data?.matchingMemberCount === 1 &&
      inspection.data.actorMatchesAudience ? (
        <Notice glyph="attention">
          If you start this run, nobody else in this audience can decide. Allow
          the starter or choose another member.
        </Notice>
      ) : null}
      {form.editable && inspection.data?.matchingMemberCount === 0 ? (
        <Notice glyph="attention">
          No active member currently matches this audience. Choose another role
          or member before starting a run.
        </Notice>
      ) : null}
    </>
  );
}
