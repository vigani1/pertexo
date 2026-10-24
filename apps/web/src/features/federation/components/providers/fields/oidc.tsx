import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Disclosure } from '@/components/ui/disclosure';
import type { useFieldValues } from '@/components/ui/use-field-validation';
type TextFields = Pick<
  ReturnType<
    typeof useFieldValues<
      | 'name'
      | 'issuer'
      | 'clientId'
      | 'clientSecret'
      | 'emailClaim'
      | 'nameClaim'
    >
  >,
  'field' | 'control'
>;
export function OidcIdentityFields({
  id,
  fields,
  locked,
  existing,
}: Readonly<{
  id: string;
  fields: TextFields;
  locked: boolean;
  existing: boolean;
}>) {
  return (
    <>
      {' '}
      <LabelledField
        id={`${id}-name`}
        label="Provider name"
        {...fields.field('name')}
      >
        {(control) => (
          <Input {...control} {...fields.control('name')} disabled={locked} />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-issuer`}
        label="OIDC issuer"
        {...fields.field('issuer')}
        description={
          !existing
            ? 'Copy the exact issuer from your identity provider. Private-network issuers are not supported.'
            : 'The issuer is fixed. Add another provider to change issuer.'
        }
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('issuer')}
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked || existing}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-client`}
        label="Client ID"
        {...fields.field('clientId')}
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('clientId')}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-secret`}
        label="Client secret"
        {...fields.field('clientSecret')}
        description={
          !existing
            ? 'The secret is shown only while you enter it.'
            : 'Leave blank to keep the configured secret.'
        }
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('clientSecret')}
            type="password"
            autoComplete="new-password"
            disabled={locked}
          />
        )}
      </LabelledField>
    </>
  );
}
export function OidcClaimFields({
  id,
  fields,
  locked,
}: Readonly<{ id: string; fields: TextFields; locked: boolean }>) {
  return (
    <Disclosure summary="Claim names" appearance={{ tone: 'strong' }}>
      <div className="space-y-3">
        <LabelledField
          id={`${id}-email`}
          label="Email claim"
          {...fields.field('emailClaim')}
          description="One scalar claim from the signed ID token. Default: email."
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('emailClaim')}
              disabled={locked}
            />
          )}
        </LabelledField>
        <LabelledField
          id={`${id}-display`}
          label="Display name claim"
          {...fields.field('nameClaim')}
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('nameClaim')}
              disabled={locked}
            />
          )}
        </LabelledField>
      </div>
    </Disclosure>
  );
}
