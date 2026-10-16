import { formRedirectUrlSchema } from '@pertexo/workflow-model';
import { Input } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/field';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../use-draft-field';

export function FormDestination({
  value,
  form,
}: Readonly<{ value: string | undefined; form: NodeFormApi }>) {
  const field = useInspectorDraftField<string | undefined>({
    value,
    format: (current) => current ?? '',
    parse: (text) => {
      if (text.trim() === '') return { ok: true, value: undefined };
      const parsed = formRedirectUrlSchema.safeParse(text.trim());
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error: 'Use an HTTPS URL without embedded credentials.',
          };
    },
    commit: (next) => {
      form.commit((node) => {
        const { redirectUrl: _previous, ...config } = node.config;
        return {
          config: {
            ...config,
            ...(next === undefined ? {} : { redirectUrl: next }),
          },
        };
      }, `${form.nodeId}:form:redirect`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch('form-redirect', scratch);
    },
  });
  return (
    <LabelledField
      id={`${form.nodeId}-form-redirect`}
      label="Redirect after submission (optional)"
      description="Leave empty to show the receipt. Otherwise continue to this fixed HTTPS URL after acceptance."
      error={field.error}
    >
      {(control) => (
        <Input
          {...control}
          type="url"
          maxLength={2048}
          value={field.text}
          disabled={!form.editable}
          onChange={(event) => {
            field.change(event.currentTarget.value);
          }}
          onBlur={field.blur}
        />
      )}
    </LabelledField>
  );
}
