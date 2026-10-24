import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApprovalAudienceInspectionResponse } from '@pertexo/contracts';
import type { TaskAudience } from '@pertexo/workflow-model';
import {
  audienceInspectionQueryOptions,
  type TaskScope,
} from '@/features/pending-tasks/queries.public';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { QueryView } from '@/components/patterns/states/query-view';
import type { NodeFormApi } from '../../../model/inspector/node-form';

/** Who could decide this audience's requests right now, when that is a problem. */
function AudienceWarning({
  found,
  allowed,
}: Readonly<{ found: ApprovalAudienceInspectionResponse; allowed: boolean }>) {
  if (found.matchingMemberCount === 0)
    return (
      <Notice glyph="attention">
        No active member currently matches this audience. Choose another role or
        member before starting a run.
      </Notice>
    );
  if (!allowed && found.matchingMemberCount === 1 && found.actorMatchesAudience)
    return (
      <Notice glyph="attention">
        If you start this run, nobody else in this audience can decide. Allow
        the starter or choose another member.
      </Notice>
    );
  return null;
}

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
      {form.editable ? (
        <QueryView
          query={inspection}
          resource="Approval audience"
          loading={null}
        >
          {(found) => <AudienceWarning found={found} allowed={allowed} />}
        </QueryView>
      ) : null}
    </>
  );
}
