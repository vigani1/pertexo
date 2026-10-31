import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioChoice } from '@/components/ui/radio-choice';
import { Textarea } from '@/components/ui/textarea';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import {
  credentialErrors,
  type CredentialField,
} from '../../model/credential-draft';
import { oauth2RedirectUrl } from '../../model/oauth2-copy';
import type { OAuth2Draft } from '../../model/oauth2-draft';

const PARAMETER_HELP =
  "Don't put secrets here; people who can see this connection can read them.";

type FormProps = Readonly<{
  draft: OAuth2Draft;
  idPrefix: string;
  disabled: boolean;
  validation: FieldValidation<CredentialField>;
  onChange: (draft: OAuth2Draft) => void;
}>;

/** Keeps a shown field message honest as its value changes. */
function changeField(
  form: FormProps,
  next: OAuth2Draft,
  field: CredentialField,
) {
  form.onChange(next);
  form.validation.change(field, credentialErrors(next)[field]);
}

function TextField({
  form,
  field,
  label,
  description,
}: Readonly<{
  form: FormProps;
  field:
    'authorizationUrl' | 'tokenUrl' | 'clientId' | 'clientSecret' | 'scope';
  label: string;
  description?: string;
}>) {
  const { draft, idPrefix, disabled, validation } = form;
  const secret = field === 'clientSecret';
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
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          spellCheck={false}
          maxLength={2_048}
          disabled={disabled}
          value={draft[field]}
          onChange={(event) => {
            changeField(
              form,
              { ...draft, [field]: event.currentTarget.value },
              field,
            );
          }}
        />
      )}
    </LabelledField>
  );
}

function LinesField({
  form,
  field,
  label,
  description,
  placeholder,
}: Readonly<{
  form: FormProps;
  field: 'authorizationParameters' | 'tokenParameters' | 'hosts';
  label: string;
  description: string;
  placeholder: string;
}>) {
  const { draft, idPrefix, disabled, validation } = form;
  return (
    <LabelledField
      id={`${idPrefix}-${field}`}
      label={label}
      description={description}
      error={validation.error(field)}
    >
      {(control) => (
        <Textarea
          {...control}
          ref={validation.register(field)}
          name={field}
          rows={2}
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          value={draft[field]}
          onChange={(event) => {
            changeField(
              form,
              { ...draft, [field]: event.currentTarget.value },
              field,
            );
          }}
        />
      )}
    </LabelledField>
  );
}

function AdvancedFields({
  form,
  consent,
}: Readonly<{ form: FormProps; consent: boolean }>) {
  const { draft, disabled, onChange } = form;
  return (
    <Disclosure summary="Advanced">
      <div className="mt-3 flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Client authentication</span>
          <RadioChoice
            label="Client authentication"
            value={draft.clientAuthentication}
            disabled={disabled}
            options={[
              { value: 'basic', label: 'Basic header' },
              { value: 'body', label: 'Request body' },
            ]}
            onChange={(clientAuthentication) => {
              onChange({ ...draft, clientAuthentication });
            }}
          />
        </div>
        {consent ? (
          <>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                aria-label="PKCE"
                className="size-4"
                checked={draft.pkce === 's256'}
                disabled={disabled}
                onChange={(event) => {
                  onChange({
                    ...draft,
                    pkce: event.currentTarget.checked ? 's256' : 'none',
                  });
                }}
              />
              PKCE
            </label>
            <LinesField
              form={form}
              field="authorizationParameters"
              label="Extra authorization parameters"
              description={PARAMETER_HELP}
              placeholder="name=value"
            />
          </>
        ) : null}
        <LinesField
          form={form}
          field="tokenParameters"
          label="Extra token parameters"
          description={PARAMETER_HELP}
          placeholder="name=value"
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Allowed API hosts</span>
          <RadioChoice
            label="Allowed API hosts"
            value={draft.hostMode}
            disabled={disabled}
            options={[
              { value: 'any', label: 'Any host' },
              { value: 'listed', label: 'Only these' },
            ]}
            onChange={(hostMode) => {
              onChange({ ...draft, hostMode });
            }}
          />
        </div>
        {draft.hostMode === 'listed' ? (
          <LinesField
            form={form}
            field="hosts"
            label="Hosts"
            description="One a line. *.example.com covers its subdomains, not example.com itself."
            placeholder="api.example.com"
          />
        ) : null}
      </div>
    </Disclosure>
  );
}

/** Everything a person fills in to connect any OAuth2 service. */
export function OAuth2Fields(form: FormProps) {
  const { draft, idPrefix, disabled, onChange } = form;
  const consent = draft.grantType === 'authorization_code';
  const redirectUrl = oauth2RedirectUrl(window.location.origin);
  return (
    <FieldGroup>
      <LabelledField
        id={`${idPrefix}-redirect`}
        label="Redirect URL"
        description="Register this address with the service first."
        slots={{
          labelAction: (
            <CopyButton value={redirectUrl} label="Copy redirect URL" />
          ),
        }}
      >
        {(control) => (
          <Input
            {...control}
            readOnly
            spellCheck={false}
            value={redirectUrl}
            className="font-mono text-[0.8rem]"
          />
        )}
      </LabelledField>
      <RadioChoice
        label="Sign-in type"
        value={draft.grantType}
        disabled={disabled}
        options={[
          { value: 'authorization_code', label: 'Sign in with consent' },
          { value: 'client_credentials', label: 'Server to server' },
        ]}
        onChange={(grantType) => {
          onChange({ ...draft, grantType });
        }}
      />
      {consent ? (
        <TextField
          form={form}
          field="authorizationUrl"
          label="Authorization URL"
        />
      ) : null}
      <TextField form={form} field="tokenUrl" label="Token URL" />
      <TextField form={form} field="clientId" label="Client ID" />
      <TextField
        form={form}
        field="clientSecret"
        label="Client secret"
        description="Stored encrypted. Nobody, including you, can see it again."
      />
      <TextField
        form={form}
        field="scope"
        label="Scope"
        description="Sent exactly as you type it."
      />
      <AdvancedFields form={form} consent={consent} />
    </FieldGroup>
  );
}
