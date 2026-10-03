import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import {
  CALL_PIN_FIELDS,
  callPinFieldErrors,
  parseCallPinText,
  readCallPinText,
  type CallPinText,
} from '../../model/inspector/workflow-call-pin';
import type { NodeConfig } from '../../model/inspector/inspector-draft';
import type { NodeFormApi } from '../../model/inspector/node-form';
import { useInspectorDraftField } from './use-inspector-draft-field';

function formatPin(config: NodeConfig): CallPinText {
  return (
    readCallPinText(config) ?? {
      workflowId: '',
      versionId: '',
      checksum: '',
      callableContractIdentity: '',
    }
  );
}

export function WorkflowCallPinEditor({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const live = useInspectorDraftField<NodeConfig, CallPinText>({
    value: config,
    format: formatPin,
    parse: parseCallPinText,
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    commit: (next) => {
      form.commit({ config: next }, `${form.nodeId}:workflow-pin`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch('workflow-pin', scratch);
    },
  });
  const errors = live.error === undefined ? {} : callPinFieldErrors(live.text);
  return (
    <FieldGroup className="gap-4">
      <Notice title="Exact same-workspace pin">
        These fields name one immutable callable version. Saving checks format
        only, not that the workflow, version, checksum and contract identity
        agree. Publication must verify that agreement. Native publishing and
        execution remain unavailable.
      </Notice>
      {CALL_PIN_FIELDS.map((field) => (
        <LabelledField
          key={field.key}
          id={`call-pin-${form.nodeId}-${field.key}`}
          label={field.label}
          description={field.hint}
          error={errors[field.key]}
        >
          {(control) => (
            <Input
              {...control}
              name={`callPin.${field.key}`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={live.text[field.key]}
              disabled={!form.editable}
              onChange={(event) => {
                live.change({
                  ...live.text,
                  [field.key]: event.currentTarget.value,
                });
              }}
              onBlur={live.blur}
            />
          )}
        </LabelledField>
      ))}
    </FieldGroup>
  );
}
