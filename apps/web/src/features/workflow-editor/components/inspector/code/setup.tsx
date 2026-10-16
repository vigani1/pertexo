import {
  Field,
  FieldControl,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { NodeConfig } from '../../../model/inspector/draft';
import {
  fieldControlId,
  type NodeFormApi,
} from '../../../model/inspector/node-form';
import { SchemaField } from '../fields/schema-field';

/** The initial plain field shares the normal draft and scoped test controls. */
export function CodeSetup({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const id = fieldControlId(form.nodeId, 'code');
  return (
    <>
      <Field>
        <FieldLabel htmlFor={id}>JavaScript</FieldLabel>
        <FieldControl>
          <Textarea
            id={id}
            name="code"
            value={typeof config.code === 'string' ? config.code : ''}
            disabled={!form.editable}
            spellCheck={false}
            autoComplete="off"
            className="min-h-56 font-mono text-xs"
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              const code = event.currentTarget.value;
              form.commit(
                (node) => ({ config: { ...node.config, code } }),
                `${form.nodeId}:config:code`,
              );
            }}
          />
        </FieldControl>
        <FieldDescription id={`${id}-hint`}>
          Return JSON from input and $vars. Await is supported. Code runs in an
          isolated process without network access. Use HTTP Request to contact a
          service.
        </FieldDescription>
      </Field>
      <SchemaField
        config={config}
        form={form}
        field={{
          key: 'timeoutSeconds',
          label: 'Time limit (seconds)',
          kind: 'number',
          required: false,
          description:
            'Defaults to 5 seconds, within the administrator’s maximum.',
        }}
      />
    </>
  );
}
