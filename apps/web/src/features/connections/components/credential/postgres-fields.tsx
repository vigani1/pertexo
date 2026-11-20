import { Checkbox } from '@/components/ui/checkbox';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioChoice } from '@/components/ui/radio-choice';
import { Textarea } from '@/components/ui/textarea';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import type { CredentialField } from '../../model/credential-draft';
import {
  postgresDraftErrors,
  type PostgresDraft,
} from '../../model/postgres-draft';

const TEXT_FIELDS = [
  ['host', 'Host'],
  ['port', 'Port'],
  ['database', 'Database'],
  ['user', 'User'],
  ['password', 'Password'],
] as const;

export function PostgresFields({
  draft,
  idPrefix,
  disabled,
  validation,
  onChange,
}: Readonly<{
  draft: PostgresDraft;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange(draft: PostgresDraft): void;
}>) {
  return (
    <FieldGroup>
      {TEXT_FIELDS.map(([field, label]) => (
        <LabelledField
          key={field}
          id={`${idPrefix}-${field}`}
          label={label}
          error={validation.error(field)}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register(field)}
              name={field}
              type={field === 'password' ? 'password' : 'text'}
              autoComplete={field === 'password' ? 'new-password' : 'off'}
              inputMode={field === 'port' ? 'numeric' : 'text'}
              spellCheck={false}
              disabled={disabled}
              value={draft[field]}
              onChange={(event) => {
                const next = { ...draft, [field]: event.currentTarget.value };
                onChange(next);
                validation.change(field, postgresDraftErrors(next)[field]);
              }}
            />
          )}
        </LabelledField>
      ))}
      <RadioChoice
        label="TLS mode"
        value={draft.tls}
        disabled={disabled}
        className="flex-wrap"
        options={[
          { value: 'require', label: 'Require' },
          { value: 'verify-full', label: 'Verify full' },
          { value: 'disable', label: 'Disable' },
        ]}
        onChange={(tls) => {
          onChange({ ...draft, tls });
        }}
      />
      {draft.tls === 'verify-full' && (
        <LabelledField
          id={`${idPrefix}-ca`}
          label="CA certificate (optional)"
          error={validation.error('ca')}
        >
          {(control) => (
            <Textarea
              {...control}
              ref={validation.register('ca')}
              disabled={disabled}
              value={draft.ca}
              onChange={(event) => {
                const next = { ...draft, ca: event.currentTarget.value };
                onChange(next);
                validation.change('ca', postgresDraftErrors(next).ca);
              }}
            />
          )}
        </LabelledField>
      )}
      {draft.tls === 'disable' && (
        <p className="text-sm text-muted-foreground">
          Unencrypted connections require a private network your operator has
          allowed.
        </p>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.readOnly}
          disabled={disabled}
          onCheckedChange={(readOnly) => {
            onChange({ ...draft, readOnly });
          }}
        />
        Read-only connection
      </label>
    </FieldGroup>
  );
}
