import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { parseConfigJson, type NodeConfig } from '../../model/inspector-draft';
import { useLiveField } from '../../use-live-field';
import type { NodeFormApi } from '../../model/node-form';

const CONFIG_JSON_FIELD = '\u0000json';

/**
 * The whole setup as JSON. Every property is kept exactly, including ones no
 * field models; valid JSON applies as you type, invalid JSON waits here.
 */
export function ConfigJsonEditor({
  config,
  form,
  description,
}: Readonly<{ config: NodeConfig; form: NodeFormApi; description: string }>) {
  const id = `node-config-${form.nodeId}`;
  const live = useLiveField<NodeConfig>({
    value: config,
    format: (value) => JSON.stringify(value, null, 2),
    parse: parseConfigJson,
    equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    commit: (next) => {
      form.commit({ config: next }, `${form.nodeId}:config-json`);
    },
    onScratchChange: (scratch) => {
      form.reportScratch(CONFIG_JSON_FIELD, scratch);
    },
  });
  return (
    <Field data-invalid={live.error !== undefined}>
      <FieldLabel htmlFor={id}>Setup as JSON</FieldLabel>
      <FieldControl state={live.error === undefined ? undefined : 'invalid'}>
        <Textarea
          id={id}
          name="nodeConfiguration"
          autoComplete="off"
          spellCheck={false}
          className="min-h-56 font-mono text-[0.8rem]"
          value={live.text}
          disabled={!form.editable}
          aria-invalid={live.error !== undefined}
          aria-describedby={`${id}-hint${live.error === undefined ? '' : ` ${id}-error`}`}
          onChange={(event) => {
            live.change(event.currentTarget.value);
          }}
        />
      </FieldControl>
      <FieldDescription id={`${id}-hint`}>{description}</FieldDescription>
      {live.error === undefined ? null : (
        <FieldError id={`${id}-error`}>{live.error}</FieldError>
      )}
    </Field>
  );
}
