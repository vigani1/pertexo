import type { WorkflowVersionResponse } from '@pertexo/contracts';
import {
  callableObjectInputSchema,
  workflowCallConfigSchema,
} from '@pertexo/workflow-model';
import type { CallTargetScope } from '../../../data/call-targets.queries';
import type { NodeConfig } from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { CallTargetPicker } from '../fields/call-target';

export function AgentCallableSetup({
  scope,
  config,
  form,
}: Readonly<{
  scope: CallTargetScope;
  config: NodeConfig;
  form: NodeFormApi;
}>) {
  const pin = workflowCallConfigSchema.safeParse({ target: config.target }).data
    ?.target;
  return (
    <CallTargetPicker
      nodeId={form.nodeId}
      editable={form.editable}
      scope={scope}
      pin={pin}
      acceptsVersion={hasObjectInput}
      onSelect={(target, version) => {
        const input = version.graph.callable?.input;
        if (input === undefined) return;
        form.commit(
          { config: { target: { ...target }, input } },
          `target:${target.workflowVersionId}`,
        );
      }}
    >
      The model proposes the selected version’s input fields and receives its
      declared result.
    </CallTargetPicker>
  );
}

function hasObjectInput(version: WorkflowVersionResponse): boolean {
  const input = version.graph.callable?.input;
  return input !== undefined && callableObjectInputSchema(input) !== undefined;
}
