import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import { CREDENTIAL_STEPS } from '../../model/connection-providers';
import {
  credentialErrors,
  type CredentialDraft,
  type CredentialField,
} from '../../model/credential-draft';
import { CredentialHelp } from './credential-help';
import { HttpHeaderEditor } from './http-header-editor';

type FieldsProps = Readonly<{
  draft: CredentialDraft;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange: (draft: CredentialDraft) => void;
  createId: () => string;
}>;

type SecretFieldProps = Readonly<{
  field: 'botToken' | 'apiKey' | 'fromEmail';
  label: string;
  value: string;
  placeholder: string;
  secret: boolean;
  description?: string;
  update: (value: string) => CredentialDraft;
}> &
  Pick<FieldsProps, 'idPrefix' | 'disabled' | 'validation' | 'onChange'>;

function CredentialInput({
  field,
  label,
  value,
  placeholder,
  secret,
  description,
  update,
  idPrefix,
  disabled,
  validation,
  onChange,
}: SecretFieldProps) {
  return (
    <LabelledField
      id={`${idPrefix}-${field}`}
      label={label}
      {...(description === undefined ? {} : { description })}
      error={validation.error(field)}
    >
      {(control) => (
        <Input
          {...control}
          ref={validation.register(field)}
          name={field}
          type={secret ? 'password' : 'email'}
          autoComplete={secret ? 'new-password' : 'email'}
          spellCheck={false}
          placeholder={placeholder}
          maxLength={512}
          disabled={disabled}
          value={value}
          onChange={(event) => {
            const next = update(event.currentTarget.value);
            onChange(next);
            validation.change(field, credentialErrors(next)[field]);
          }}
        />
      )}
    </LabelledField>
  );
}

/** The provider's credential inputs. Secrets stay masked and local. */
export function CredentialFields(props: FieldsProps) {
  const { draft } = props;
  if (draft.provider === 'http')
    return (
      <HttpHeaderEditor
        draft={draft}
        idPrefix={props.idPrefix}
        disabled={props.disabled}
        validation={props.validation}
        onChange={props.onChange}
        createId={props.createId}
      />
    );
  if (draft.provider === 'slack')
    return (
      <FieldGroup>
        <CredentialInput
          {...props}
          field="botToken"
          label="Slack bot token"
          value={draft.botToken}
          placeholder="xoxb-…"
          secret
          description="Stored encrypted. Nobody, including you, can see it again."
          update={(botToken) => ({ ...draft, botToken })}
        />
        <CredentialHelp steps={CREDENTIAL_STEPS.slack} />
      </FieldGroup>
    );
  return (
    <FieldGroup>
      <CredentialInput
        {...props}
        field="apiKey"
        label="Resend API key"
        value={draft.apiKey}
        placeholder="re_…"
        secret
        description="Stored encrypted. Nobody, including you, can see it again."
        update={(apiKey) => ({ ...draft, apiKey })}
      />
      <CredentialHelp steps={CREDENTIAL_STEPS.email} />
      <CredentialInput
        {...props}
        field="fromEmail"
        label="From address"
        value={draft.fromEmail}
        placeholder="alerts@yourdomain.com"
        secret={false}
        description="Emails come from this address. Its domain must be verified in Resend."
        update={(fromEmail) => ({ ...draft, fromEmail })}
      />
    </FieldGroup>
  );
}
