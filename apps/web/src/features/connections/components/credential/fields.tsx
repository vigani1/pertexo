import { Checkbox } from '@/components/ui/checkbox';
import {
  FieldDescription,
  FieldGroup,
  LabelledField,
} from '@/components/ui/field';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { RadioChoice } from '@/components/ui/radio-choice';
import { SchemaTextControl } from '@/components/ui/schema-text-control';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import {
  credentialErrors,
  type CredentialDraft,
  type CredentialField,
} from '../../model/credential-draft';
import {
  credentialFields,
  isVisibleField,
  isRequiredField,
  type ScalarValue,
  type SchemaCredentialDraft,
} from '../../model/schema-credential';
import { CredentialHelp } from './help';
import { HttpHeaderEditor } from './http-header-editor';
import { OAuth2Fields } from './oauth2-fields';
import { SECRET_DESCRIPTION } from './secret-description';

type FieldsProps = Readonly<{
  draft: CredentialDraft | undefined;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange: (draft: CredentialDraft) => void;
  createId: () => string;
}>;

export function CredentialFields({ draft, ...props }: FieldsProps) {
  if (draft === undefined) return null;
  if (draft.provider === 'oauth2')
    return <OAuth2Fields {...props} draft={draft} />;
  if (draft.provider === 'http')
    return <HttpHeaderEditor {...props} draft={draft} />;
  return <ScalarFields {...props} draft={draft} />;
}

type ScalarProps = Omit<FieldsProps, 'draft' | 'createId'> &
  Readonly<{ draft: SchemaCredentialDraft }>;

function ScalarFields(props: ScalarProps) {
  const { draft } = props;
  return (
    <FieldGroup>
      {credentialFields(draft.definition).map((field) =>
        isVisibleField(field.metadata, draft.values) ? (
          <ScalarField key={field.key} form={props} field={field} />
        ) : null,
      )}
    </FieldGroup>
  );
}

function ScalarField({
  form,
  field,
}: Readonly<{
  form: ScalarProps;
  field: ReturnType<typeof credentialFields>[number];
}>) {
  const { draft, idPrefix, disabled, validation, onChange } = form;
  const { key, label, description, metadata } = field;
  const secret = metadata.secret === true;
  const hint = secret
    ? [description, SECRET_DESCRIPTION].filter(Boolean).join(' ')
    : description;
  const value = draft.values[key];
  const error = validation.error(key);
  function update(value: ScalarValue) {
    const next = { ...draft, values: { ...draft.values, [key]: value } };
    onChange(next);
    validation.change(key, credentialErrors(next)[key]);
  }

  if (field.kind === 'boolean')
    return (
      <div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onCheckedChange={update}
          />
          {label}
        </label>
        {hint === undefined ? null : (
          <FieldDescription>{hint}</FieldDescription>
        )}
      </div>
    );
  if (field.options !== undefined)
    return (
      <>
        <RadioChoice
          label={label}
          value={String(value ?? '')}
          disabled={disabled}
          className="flex-wrap"
          options={field.options.map((option) => ({
            value: option,
            label: field.optionLabels?.[option] ?? option,
          }))}
          onChange={update}
        />
        {error === undefined ? null : (
          <Notice tone="destructive">{error}</Notice>
        )}
        {hint === undefined ? null : (
          <FieldDescription>{hint}</FieldDescription>
        )}
        <ChoiceNotice metadata={metadata} value={value} />
      </>
    );

  const email = metadata.format === 'email';
  const plainInputType = email ? 'email' : 'text';
  const plainAutocomplete = email ? 'email' : 'off';
  const help = Array.isArray(metadata.help)
    ? metadata.help.filter((step): step is string => typeof step === 'string')
    : undefined;
  return (
    <>
      <LabelledField
        id={`${idPrefix}-${key}`}
        label={label}
        description={hint}
        error={error}
      >
        {(control) =>
          metadata.multiline === true ? (
            <SchemaTextControl
              {...control}
              multiline
              ref={validation.register(key)}
              disabled={disabled}
              value={String(value ?? '')}
              onTextChange={update}
            />
          ) : (
            <SchemaTextControl
              {...control}
              ref={validation.register(key)}
              name={key}
              aria-required={isRequiredField(field, draft.values)}
              type={secret ? 'password' : plainInputType}
              autoComplete={secret ? 'new-password' : plainAutocomplete}
              inputMode={metadata.numericInput === true ? 'numeric' : undefined}
              spellCheck={false}
              placeholder={
                typeof metadata.placeholder === 'string'
                  ? metadata.placeholder
                  : undefined
              }
              maxLength={
                typeof metadata.inputMaxLength === 'number'
                  ? metadata.inputMaxLength
                  : undefined
              }
              disabled={disabled}
              value={String(value ?? '')}
              onTextChange={update}
            />
          )
        }
      </LabelledField>
      {help === undefined ? null : <CredentialHelp steps={help} />}
    </>
  );
}

function ChoiceNotice({
  metadata,
  value,
}: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  value: ScalarValue | undefined;
}>) {
  if (metadata.notice === 'smtp_plaintext' && value === 'none')
    return (
      <Notice tone="warning">
        Credentials and email travel without encryption. Use only with a trusted
        relay. The operator must permit plain SMTP with SMTP_ALLOW_PLAINTEXT.
      </Notice>
    );
  if (metadata.notice === 'postgres_plaintext' && value === 'disable')
    return (
      <p className="text-sm text-muted-foreground">
        Unencrypted connections require a private network your operator has
        allowed.
      </p>
    );
  return null;
}
