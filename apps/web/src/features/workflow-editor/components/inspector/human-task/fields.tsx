import {
  canonicalJson,
  formFieldsSchema,
  type FormField,
} from '@pertexo/workflow-model';
import { FormFieldsEditor } from '@/features/forms/fields.public';
import { Notice } from '@/components/ui/notice';
import { useInspectorDraftField } from '../use-draft-field';
import type { NodeFormApi } from '../../../model/inspector/node-form';
export function FormFields({
  fields,
  form,
}: Readonly<{ fields: readonly FormField[]; form: NodeFormApi }>) {
  const field = useInspectorDraftField<
    readonly FormField[],
    readonly FormField[]
  >({
    value: fields,
    format: (value) => value,
    parse: (input) => {
      const parsed = formFieldsSchema.safeParse(input);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error: parsed.error.issues[0]?.message ?? 'Check the form fields.',
          };
    },
    equals: (left, right) => canonicalJson(left) === canonicalJson(right),
    commit: (value) => {
      form.commit(
        (node) => ({ config: { ...node.config, fields: [...value] } }),
        `${form.nodeId}:form:fields`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch('form-fields', scratch);
    },
  });
  return (
    <div className="flex flex-col gap-3" onBlurCapture={field.blur}>
      <FormFieldsEditor
        fields={field.text}
        onChange={field.change}
        disabled={!form.editable}
      />
      {field.error === undefined ? null : (
        <Notice tone="destructive">{field.error}</Notice>
      )}
    </div>
  );
}
