import {
  approvalConfigSchema,
  PENDING_TASK_LIMITS,
  FORM_LIMITS,
  formThankYouMessageSchema,
} from '@pertexo/workflow-model';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LabelledField } from '@/components/ui/field';
import { useInspectorDraftField } from '../use-draft-field';
import type { NodeFormApi } from '../../../model/inspector/node-form';
const TEXT_FIELDS = {
  title: {
    label: 'Request title',
    error: 'Enter a title up to 160 characters.',
  },
  instructions: {
    label: 'Instructions',
    error: 'Use at most 2,000 characters.',
    description: 'Optional context for the person responding.',
  },
  thankYouMessage: {
    label: 'Thank-you message',
    error: 'Use 1–1,000 characters.',
    description:
      'Shown after acceptance. HTTP and HTTPS URLs become links. The run may still be waiting or running.',
  },
};

export function TaskTextField({
  name,
  value,
  form,
}: Readonly<{
  name: 'title' | 'instructions' | 'thankYouMessage';
  value: string;
  form: NodeFormApi;
}>) {
  const details = TEXT_FIELDS[name];
  const field = useInspectorDraftField({
    value,
    format: (current) => current,
    parse: (text) => {
      const schema =
        name === 'thankYouMessage'
          ? formThankYouMessageSchema
          : approvalConfigSchema.shape[name];
      const parsed = schema.safeParse(text);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error: details.error,
          };
    },
    commit: (next) => {
      form.commit(
        (node) => ({ config: { ...node.config, [name]: next } }),
        `${form.nodeId}:approval:${name}`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch(`approval-${name}`, scratch);
    },
  });
  return (
    <LabelledField
      id={`${form.nodeId}-approval-${name}`}
      label={details.label}
      error={field.error}
      {...('description' in details
        ? { description: details.description }
        : {})}
    >
      {(control) =>
        name === 'title' ? (
          <Input
            {...control}
            value={field.text}
            maxLength={PENDING_TASK_LIMITS.titleCharacters}
            disabled={!form.editable}
            onChange={(event) => {
              field.change(event.target.value);
            }}
            onBlur={field.blur}
          />
        ) : (
          <Textarea
            {...control}
            value={field.text}
            maxLength={
              name === 'thankYouMessage'
                ? FORM_LIMITS.thankYouCharacters
                : PENDING_TASK_LIMITS.instructionsCharacters
            }
            rows={4}
            disabled={!form.editable}
            onChange={(event) => {
              field.change(event.target.value);
            }}
            onBlur={field.blur}
          />
        )
      }
    </LabelledField>
  );
}
