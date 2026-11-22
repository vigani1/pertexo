import {
  approvalConfigSchema,
  AGENT_LIMITS,
  PENDING_TASK_LIMITS,
  isRecord,
} from '@pertexo/workflow-model';
import { Field, FieldLabel } from '@/components/ui/field';
import type { TaskScope } from '@/features/pending-tasks/pending-tasks-queries.public';
import { Checkbox } from '@/components/ui/checkbox';
import {
  withConfigValue,
  type NodeConfig,
} from '../../../model/inspector/draft';
import { nestedConfigForm } from '../../../model/inspector/nested-config-form';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { ChoiceSelect } from '../fields/choice-select';
import { DurationField } from '../fields/duration';
import { AudienceField } from '../human-task/audience';
import { TaskTextField } from '../human-task/text';

const permissions = [
  { value: null, label: 'Choose an approval rule' },
  { value: 'approval', label: 'Require approval' },
  { value: 'allow', label: 'Allow without approval' },
] as const;
const defaultApproval = approvalConfigSchema.parse({
  expiresAfterSeconds: PENDING_TASK_LIMITS.minimumExpirySeconds,
});

export function AgentApprovalSetup({
  scope,
  form,
  tool,
}: Readonly<{ scope: TaskScope; form: NodeFormApi; tool: NodeConfig }>) {
  const permission = isRecord(tool.writePermission)
    ? tool.writePermission
    : undefined;
  const kind =
    permission?.kind === 'allow' || permission?.kind === 'approval'
      ? permission.kind
      : null;
  const approval =
    approvalConfigSchema.safeParse(permission?.config).data ?? defaultApproval;
  const configForm = nestedConfigForm(
    nestedConfigForm(nestedConfigForm(form, 'tool'), 'writePermission'),
    'config',
  );
  const id = fieldControlId(form.nodeId, 'agent-approval');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>Write approval</FieldLabel>
        <ChoiceSelect
          value={kind}
          choices={permissions}
          disabled={!form.editable}
          control={{ id }}
          onChange={(value) => {
            if (value !== 'approval' && value !== 'allow') return;
            form.commit((node) => {
              const current = isRecord(node.config.tool)
                ? (node.config.tool as NodeConfig)
                : {};
              const writePermission =
                value === 'allow'
                  ? { kind: value }
                  : { kind: value, config: defaultApproval };
              const currentDeadline =
                typeof node.config.timeoutMillis === 'number'
                  ? node.config.timeoutMillis
                  : AGENT_LIMITS.timeoutMillis;
              const minimumDeadline =
                (defaultApproval.expiresAfterSeconds + 1) * 1_000;
              return {
                config: {
                  ...withConfigValue(node.config, 'tool', {
                    ...current,
                    writePermission,
                  }),
                  ...(value === 'approval' && currentDeadline < minimumDeadline
                    ? { timeoutMillis: minimumDeadline }
                    : {}),
                },
              };
            }, 'agent-approval');
          }}
        />
      </Field>
      {kind === 'approval' ? (
        <>
          <TaskTextField
            name="title"
            value={approval.title}
            form={configForm}
          />
          <TaskTextField
            name="instructions"
            value={approval.instructions}
            form={configForm}
          />
          <DurationField
            config={approval}
            form={configForm}
            configKey="expiresAfterSeconds"
            label="Approval expiry"
            description="Set the Agent deadline beyond this approval window."
            minimumSeconds={PENDING_TASK_LIMITS.minimumExpirySeconds}
            maximumSeconds={PENDING_TASK_LIMITS.maximumExpirySeconds}
          />
          <AudienceField
            scope={scope}
            form={configForm}
            audience={approval.audience}
            onChange={(audience) => {
              if (audience.roles.length + audience.memberIds.length === 0)
                return;
              configForm.commit(
                (node) => ({
                  config: withConfigValue(node.config, 'audience', audience),
                }),
                'agent-approval-audience',
              );
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={approval.allowStarterToDecide ?? false}
              disabled={!form.editable}
              onCheckedChange={(checked) => {
                configForm.commit(
                  (node) => ({
                    config: withConfigValue(
                      node.config,
                      'allowStarterToDecide',
                      checked,
                    ),
                  }),
                  'agent-approval-starter',
                );
              }}
            />
            Let the person who started the run decide
          </label>
        </>
      ) : null}
    </>
  );
}
