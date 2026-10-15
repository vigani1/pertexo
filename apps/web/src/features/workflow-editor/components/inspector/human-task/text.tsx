import {
  approvalConfigSchema,
  PENDING_TASK_LIMITS,
} from '@pertexo/workflow-model';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LabelledField } from '@/components/ui/field';
import { useInspectorDraftField } from '../use-draft-field';
import type { NodeFormApi } from '../../../model/inspector/node-form';
export function TaskTextField({
  name,
  value,
  form,
}: Readonly<{
  name: 'title' | 'instructions';
  value: string;
  form: NodeFormApi;
}>) {
  const field = useInspectorDraftField({
    value,
    format: (current) => current,
    parse: (text) => {
      const parsed = approvalConfigSchema.shape[name].safeParse(text);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error:
              name === 'title'
                ? 'Enter a title up to 160 characters.'
                : 'Use at most 2,000 characters.',
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
      label={name === 'title' ? 'Request title' : 'Instructions'}
      error={field.error}
      {...(name === 'instructions'
        ? { description: 'Optional context for the person responding.' }
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
            maxLength={PENDING_TASK_LIMITS.instructionsCharacters}
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
