import { FormAccessControl } from '@/features/forms/sharing.public';
import type { MemberFormScope } from '@/features/forms/queries.public';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  formConfigSchema,
  type TaskAudience,
  type FormConfig,
  type ApprovalConfig,
  type InputRequestConfig,
} from '@pertexo/workflow-model';
import { Notice } from '@/components/ui/notice';
import type { NodeConfig } from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { ConfigJsonEditor } from '../fields/config-json-editor';
import { TaskTextField } from './text';
import { ExpiryField } from './expiry';
import { AudienceField } from './audience';
import { StarterDecisionField } from './starter-decision';
import { FormFields } from './fields';
type Setup =
  | Readonly<{ definitionKey: 'core.form'; config: FormConfig }>
  | Readonly<{ definitionKey: 'core.approval'; config: ApprovalConfig }>
  | Readonly<{
      definitionKey: 'core.request_input';
      config: InputRequestConfig;
    }>;
function readSetup(
  definitionKey: Setup['definitionKey'],
  config: NodeConfig,
): Setup | null {
  if (definitionKey === 'core.form') {
    const parsed = formConfigSchema.safeParse(config);
    return parsed.success ? { definitionKey, config: parsed.data } : null;
  }
  if (definitionKey === 'core.request_input') {
    const parsed = inputRequestConfigSchema.safeParse(config);
    return parsed.success ? { definitionKey, config: parsed.data } : null;
  }
  const parsed = approvalConfigSchema.safeParse(config);
  return parsed.success ? { definitionKey, config: parsed.data } : null;
}
export function HumanFormSetup({
  config,
  definitionKey,
  form,
  scope,
}: Readonly<{
  config: NodeConfig;
  definitionKey: 'core.form' | 'core.approval' | 'core.request_input';
  form: NodeFormApi;
  scope: MemberFormScope;
}>) {
  const parsed = readSetup(definitionKey, config);
  if (parsed === null)
    return (
      <ConfigJsonEditor
        config={config}
        form={form}
        description="Correct the form fields and audience in this setup."
      />
    );
  const { definitionKey: kind, config: captured } = parsed;
  const text = (
    <>
      <TaskTextField name="title" value={captured.title} form={form} />
      <TaskTextField
        name="instructions"
        value={captured.instructions}
        form={form}
      />
    </>
  );
  if (kind === 'core.form')
    return (
      <>
        {text}
        <FormFields fields={captured.fields} form={form} />
        <FormAccessControl scope={scope} editable={form.editable} />
      </>
    );
  function changeAudience(next: TaskAudience) {
    if (next.roles.length + next.memberIds.length === 0) return;
    form.commit(
      (node) => ({
        config: {
          ...node.config,
          audience: { roles: [...next.roles], memberIds: [...next.memberIds] },
        },
      }),
      `${form.nodeId}:task:audience`,
    );
  }
  return (
    <>
      {text}
      <Notice>
        In Inputs, map a details object with named text, number or boolean facts
        (up to 20 fields, 8 KB). They are saved when the request opens.
        {kind === 'core.request_input'
          ? ' Map prefill to an object keyed by field name to supply editable starting values.'
          : ''}
      </Notice>
      {kind === 'core.request_input' ? (
        <FormFields fields={captured.fields} form={form} />
      ) : null}
      <ExpiryField seconds={captured.expiresAfterSeconds} form={form} />
      <AudienceField
        purpose={kind === 'core.approval' ? 'approval' : 'input_request'}
        scope={scope}
        form={form}
        audience={captured.audience}
        onChange={changeAudience}
      />
      {kind === 'core.approval' ? (
        <StarterDecisionField
          scope={scope}
          form={form}
          audience={captured.audience}
          allowed={captured.allowStarterToDecide === true}
        />
      ) : null}
      <Notice glyph="waiting">
        {kind === 'core.approval'
          ? captured.allowStarterToDecide === true
            ? 'One eligible person approves or rejects, including the starter if they belong to the audience.'
            : 'One eligible person approves or rejects. The person who started the run cannot decide.'
          : 'One eligible member fills in this form. The person who started the run may respond.'}{' '}
        Human waiting releases the active slot and pauses the execution budget;
        an explicit absolute deadline still applies.
      </Notice>
    </>
  );
}
