import type { InputMapping as ValueSource } from '../../model/inspector/input-mappings';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  equalCallableResultSources,
  formatCallableResultSource,
  parseCallableResultSourceText,
} from '../../model/inspector/callable-result-source';
import { useInspectorDraftField } from './use-inspector-draft-field';
import { useEditorStore } from '../../model/editor-store-context';
import { CallableResultStepPicker } from './callable-result-step-picker';
import { FieldGroup } from '@/components/ui/field';

export function CallableResultSourceEditor({
  value,
  editable,
  onChange,
  onScratchChange,
}: Readonly<{
  value: ValueSource;
  editable: boolean;
  onChange: (value: ValueSource) => void;
  onScratchChange: (hasScratch: boolean) => void;
}>) {
  const rootNodes = useEditorStore((state) => state.graph.nodes);
  const live = useInspectorDraftField({
    value,
    format: formatCallableResultSource,
    parse: parseCallableResultSourceText,
    equals: equalCallableResultSources,
    commit: onChange,
    onScratchChange,
  });
  return (
    <FieldGroup>
      <CallableResultStepPicker
        nodes={rootNodes}
        source={value}
        disabled={!editable || live.hasScratch}
        onPick={(nodeId) => {
          live.change(
            formatCallableResultSource({
              kind: 'node_output',
              nodeId,
              path: '$',
            }),
          );
        }}
      />
      <LabelledField
        id="callable-result-source"
        label="Result source"
        error={live.error}
        description={
          <>
            One value source for the returned object. For example:{' '}
            {'{"kind":"node_output","nodeId":"step-id","path":"$"}'}. Use a
            top-level step with exactly one successful durable invocation.
            Missing, skipped, unsuccessful or ambiguous outputs fail result
            validation, including outputs referenced by an expression. Use an
            explicit unique result-producing step, not last-value selection or
            implicit aggregation. Saving checks the source format; it does not
            evaluate it or validate the returned object against the result type.
          </>
        }
      >
        {(control) => (
          <Textarea
            {...control}
            name="callable-result-source"
            autoComplete="off"
            spellCheck={false}
            className="min-h-32 font-mono"
            value={live.text}
            disabled={!editable}
            onChange={(event) => {
              live.change(event.currentTarget.value);
            }}
            onBlur={live.blur}
          />
        )}
      </LabelledField>
    </FieldGroup>
  );
}
