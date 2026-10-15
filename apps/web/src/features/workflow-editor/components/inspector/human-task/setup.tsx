import { TaskTextField } from './text';
import { ExpiryField } from './expiry';
import {
  approvalConfigSchema,
  type TaskAudience,
} from '@pertexo/workflow-model';
import { Notice } from '@/components/ui/notice';
import type { TaskScope } from '@/features/pending-tasks/queries.public';
import type { NodeConfig } from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { ConfigJsonEditor } from '../fields/config-json-editor';
import { AudienceField } from './audience';
export function ApprovalSetup({
  config,
  form,
  scope,
}: Readonly<{ config: NodeConfig; form: NodeFormApi; scope: TaskScope }>) {
  const parsed = approvalConfigSchema.safeParse(config);
  if (!parsed.success)
    return (
      <ConfigJsonEditor
        config={config}
        form={form}
        description="Correct this approval setup. Choose at least one role or active workspace member."
      />
    );
  const audience = parsed.data.audience;
  function change(next: TaskAudience) {
    if (next.roles.length + next.memberIds.length === 0) return;
    form.commit(
      {
        config: {
          ...parsed.data,
          audience: { roles: [...next.roles], memberIds: [...next.memberIds] },
        },
      },
      `${form.nodeId}:approval:audience`,
    );
  }
  return (
    <>
      <TaskTextField name="title" value={parsed.data.title} form={form} />
      <TaskTextField
        name="instructions"
        value={parsed.data.instructions}
        form={form}
      />
      <ExpiryField seconds={parsed.data.expiresAfterSeconds} form={form} />
      <AudienceField
        scope={scope}
        form={form}
        audience={audience}
        onChange={change}
      />
      <Notice glyph="waiting">
        One eligible person approves or rejects. The person who started the run
        cannot decide. Human waiting releases the active slot and pauses the
        execution budget; an explicit absolute deadline still applies.
      </Notice>
    </>
  );
}
