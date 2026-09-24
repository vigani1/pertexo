import { Field, FieldLabel, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type {
  InputMappingDraftRow,
  SchemaValueType,
} from '../../../model/input-mappings';

type LiteralRow = Extract<InputMappingDraftRow, { kind: 'literal' }>;

/**
 * A fixed value for one input, edited the way its type reads: text, a
 * number, an on/off switch, or JSON for anything structured.
 */
export function LiteralEditor({
  row,
  type,
  controlId,
  error,
  disabled,
  onChange,
}: Readonly<{
  row: LiteralRow;
  type: SchemaValueType | undefined;
  controlId: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (row: LiteralRow) => void;
}>) {
  const parsed = parseLiteral(row.literalJson);
  const mode = editorMode(type, parsed);
  if (mode === 'boolean')
    return (
      <Field>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={controlId}>Value</FieldLabel>
          <Switch
            id={controlId}
            checked={parsed.value === true}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ ...row, literalJson: JSON.stringify(checked) });
            }}
          />
        </div>
      </Field>
    );
  const thread = error === undefined ? undefined : 'invalid';
  if (mode === 'string' || mode === 'number')
    return (
      <LabelledField id={controlId} label="Value" error={error} thread={thread}>
        {(control) => (
          <Input
            {...control}
            name={`inputMapping.${row.id}.value`}
            autoComplete="off"
            inputMode={mode === 'number' ? 'decimal' : undefined}
            className={mode === 'number' ? 'font-mono' : undefined}
            value={literalText(mode, parsed, row.literalJson)}
            disabled={disabled}
            onChange={(event) => {
              const text = event.currentTarget.value;
              onChange({
                ...row,
                literalJson: mode === 'string' ? JSON.stringify(text) : text,
              });
            }}
          />
        )}
      </LabelledField>
    );
  return (
    <LabelledField
      id={controlId}
      label="JSON value"
      error={error}
      thread={thread}
    >
      {(control) => (
        <Textarea
          {...control}
          name={`inputMapping.${row.id}.literal`}
          autoComplete="off"
          spellCheck={false}
          className="min-h-20 font-mono text-[0.8rem]"
          value={row.literalJson}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...row, literalJson: event.currentTarget.value });
          }}
        />
      )}
    </LabelledField>
  );
}

/** The text a typed editor shows for the stored JSON value. */
function literalText(
  mode: 'string' | 'number',
  parsed: ParsedLiteral,
  literalJson: string,
): string {
  if (mode === 'string')
    return typeof parsed.value === 'string' ? parsed.value : '';
  return literalJson === 'null' ? '' : literalJson;
}

type ParsedLiteral = Readonly<{ ok: boolean; value: unknown }>;

function parseLiteral(json: string): ParsedLiteral {
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Typed editors only when the stored value already fits the type (a fresh
 * row holds null); anything else stays in JSON so no value is reshaped.
 */
function editorMode(
  type: SchemaValueType | undefined,
  parsed: ParsedLiteral,
): 'string' | 'number' | 'boolean' | 'json' {
  const fresh = parsed.ok && parsed.value === null;
  if (type === 'string' && (fresh || typeof parsed.value === 'string'))
    return 'string';
  if (type === 'boolean' && (fresh || typeof parsed.value === 'boolean'))
    return 'boolean';
  if (
    (type === 'number' || type === 'integer') &&
    (fresh || typeof parsed.value === 'number' || !parsed.ok)
  )
    return 'number';
  return 'json';
}
