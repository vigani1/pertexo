import { EventCoordinationSetup } from '../event-coordination/setup';
import { TaskContextEditor } from './context-editor';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import { FormDestination } from './destination';
import {
  FormAccessControl,
  FormEventHistory,
} from '@/features/forms/sharing.public';
import type { MemberFormScope } from '@/features/forms/queries.public';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  formConfigSchema,
  DEFAULT_FORM_THANK_YOU_MESSAGE,
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
  node,
  graph,
  definitionKey,
  form,
  scope,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  definitionKey: 'core.form' | 'core.approval' | 'core.request_input';
  form: NodeFormApi;
  scope: MemberFormScope;
}>) {
  const config = node.config;
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
        <TaskTextField
          name="thankYouMessage"
          value={captured.thankYouMessage ?? DEFAULT_FORM_THANK_YOU_MESSAGE}
          form={form}
        />
        <FormDestination value={captured.redirectUrl} form={form} />
        <FormFields fields={captured.fields} form={form} />
        <EventCoordinationSetup node={node} graph={graph} form={form} />
        <FormAccessControl scope={scope} editable={form.editable} />
        {form.editable ? <FormEventHistory scope={scope} /> : null}
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
      <TaskContextEditor
        variableScope={scope}
        node={node}
        graph={graph}
        form={form}
        group="details"
      />
      {kind === 'core.request_input' ? (
        <TaskContextEditor
          variableScope={scope}
          node={node}
          graph={graph}
          form={form}
          group="prefill"
          fields={captured.fields}
        />
      ) : null}
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
          allowed={captured.allowStarterToDecide ?? false}
        />
      ) : null}
      <Notice glyph="waiting">
        {decisionGuidance(parsed)} Human waiting releases the active slot and
        pauses the execution budget; an explicit absolute deadline still
        applies.
      </Notice>
    </>
  );
}

function decisionGuidance(input: Setup) {
  if (input.definitionKey !== 'core.approval')
    return 'One eligible member fills in this form. The person who started the run may respond.';
  if (input.config.allowStarterToDecide ?? false)
    return 'One eligible person approves or rejects, including the starter if they belong to the audience.';
  return 'One eligible person approves or rejects. The person who started the run cannot decide.';
}
