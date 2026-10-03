import {
  CALLABLE_TYPE_LIMITS_V1,
  type CallableObjectTypeDescriptorV1,
} from '@pertexo/workflow-model/callable-type-contract';
import { LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  equalCallableTypes,
  formatCallableType,
  parseCallableTypeText,
} from '../../model/inspector/callable-type-editor';
import { useInspectorDraftField } from './use-inspector-draft-field';

/** Local unfinished text; the caller alone owns the applied graph contract. */
export function CallableTypeEditor({
  id,
  label,
  value,
  onChange,
  editable,
  onScratchChange,
}: Readonly<{
  id: string;
  label: string;
  value: CallableObjectTypeDescriptorV1;
  onChange: (value: CallableObjectTypeDescriptorV1) => void;
  editable: boolean;
  /** The inspector owner clears scratch when replacing or disposing its scope. */
  onScratchChange: (hasScratch: boolean) => void;
}>) {
  const live = useInspectorDraftField({
    value,
    format: formatCallableType,
    parse: parseCallableTypeText,
    equals: equalCallableTypes,
    commit: onChange,
    onScratchChange,
  });
  return (
    <LabelledField
      id={id}
      label={label}
      error={live.error}
      description={
        <>
          Declare an object with properties and required names. Only declared
          properties are accepted. Types: string, number, integer, boolean,
          null, object, or array with items and maxItems (1–
          {CALLABLE_TYPE_LIMITS_V1.maxItems.toLocaleString()}). Property names
          start with a letter or underscore and contain only letters, digits and
          underscores; __proto__, prototype and constructor are not allowed.
          Limits: {CALLABLE_TYPE_LIMITS_V1.depth} levels,{' '}
          {CALLABLE_TYPE_LIMITS_V1.descriptors} types and{' '}
          {CALLABLE_TYPE_LIMITS_V1.properties} properties per object. This is a
          type descriptor, not JSON Schema.
        </>
      }
    >
      {(control) => (
        <Textarea
          {...control}
          name={id}
          autoComplete="off"
          spellCheck={false}
          className="min-h-48 font-mono"
          value={live.text}
          disabled={!editable}
          onChange={(event) => {
            live.change(event.currentTarget.value);
          }}
          onBlur={live.blur}
        />
      )}
    </LabelledField>
  );
}
