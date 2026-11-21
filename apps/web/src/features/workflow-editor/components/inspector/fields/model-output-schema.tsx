import { prepareModelOutputSchema } from '@pertexo/integrations';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  parseConfigJson,
  withConfigValue,
  type NodeConfig,
} from '../../../model/inspector/draft';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { useInspectorDraftField } from '../use-draft-field';

const property = 'outputSchema';

export function ModelOutputSchema({
  config,
  form,
}: Readonly<{ config: NodeConfig; form: NodeFormApi }>) {
  const live = useInspectorDraftField({
    value: config[property],
    format: (value) =>
      value === undefined ? '' : JSON.stringify(value, null, 2),
    parse: (text) => {
      const result = parseConfigJson(text);
      if (!result.ok) return result;
      return prepareModelOutputSchema(result.value) === undefined
        ? {
            ok: false,
            error:
              'Use an object schema with supported keywords. References and other JSON Schema keywords are unsupported.',
          }
        : result;
    },
    commit: (value) => {
      form.commit(
        (node) => ({ config: withConfigValue(node.config, property, value) }),
        `${form.nodeId}:config:${property}`,
      );
    },
    onScratchChange: (scratch) => {
      form.reportScratch(property, scratch);
    },
  });
  return (
    <LabelledField
      id={`${form.nodeId}-output-schema`}
      label="Output schema"
      error={live.error}
    >
      {(control) => (
        <Textarea
          {...control}
          aria-required
          autoComplete="off"
          spellCheck={false}
          className="min-h-32 font-mono"
          value={live.text}
          disabled={!form.editable}
          onChange={(event) => {
            live.change(event.currentTarget.value);
          }}
          onBlur={live.blur}
        />
      )}
    </LabelledField>
  );
}
