import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { RadioChoice } from '@/components/ui/radio-choice';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import type { CredentialField } from '../../model/credential-draft';
import {
  smtpDraftErrors,
  type SmtpDraft,
  type SmtpField,
} from '../../model/smtp-draft';

export function SmtpFields({
  draft,
  idPrefix,
  disabled,
  validation,
  onChange,
}: Readonly<{
  draft: SmtpDraft;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange: (draft: SmtpDraft) => void;
}>) {
  const fields: readonly Readonly<{
    field: Exclude<SmtpField, 'security'>;
    label: string;
    secret?: boolean;
    maxLength: number;
  }>[] = [
    { field: 'host', label: 'SMTP host', maxLength: 253 },
    { field: 'port', label: 'Port', maxLength: 5 },
    { field: 'username', label: 'Username', maxLength: 1024 },
    { field: 'password', label: 'Password', secret: true, maxLength: 4096 },
    { field: 'fromEmail', label: 'From address', maxLength: 254 },
    { field: 'fromName', label: 'From name (optional)', maxLength: 128 },
  ];
  return (
    <div className="flex flex-col gap-4">
      {fields.map(({ field, label, secret, maxLength }) => (
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
              disabled={disabled}
              type={secret ? 'password' : 'text'}
              maxLength={maxLength}
              autoComplete={secret ? 'new-password' : 'off'}
              spellCheck={false}
              value={draft[field]}
              onChange={(event) => {
                const next = { ...draft, [field]: event.currentTarget.value };
                onChange(next);
                validation.change(field, smtpDraftErrors(next)[field]);
              }}
            />
          )}
        </LabelledField>
      ))}
      <RadioChoice
        label="Security"
        className="flex w-full flex-wrap"
        value={draft.security}
        disabled={disabled}
        options={[
          { value: 'implicit', label: 'Implicit TLS' },
          { value: 'starttls', label: 'STARTTLS required' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(security) => {
          onChange({ ...draft, security });
          validation.change('security', undefined);
        }}
      />
      {validation.error('security') === undefined ? null : (
        <Notice tone="destructive">{validation.error('security')}</Notice>
      )}
      {draft.security === 'none' ? (
        <Notice tone="warning">
          Credentials and email travel without encryption. Use only with a
          trusted relay. The operator must permit plain SMTP with
          SMTP_ALLOW_PLAINTEXT.
        </Notice>
      ) : null}
    </div>
  );
}
