import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Disclosure } from '@/components/ui/disclosure';
import type { useFieldValues } from '@/components/ui/use-field-validation';
import { Textarea } from '@/components/ui/textarea';
type TextFields = Pick<
  ReturnType<
    typeof useFieldValues<
      | 'name'
      | 'issuer'
      | 'signInUrl'
      | 'certificate'
      | 'nextCertificate'
      | 'emailAttribute'
      | 'nameAttribute'
    >
  >,
  'field' | 'control'
>;
export function SamlIdentityFields({
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
        label="IdP entity ID"
        {...fields.field('issuer')}
        description={
          !existing
            ? 'Copy the identifier exactly. It is not a navigation address.'
            : 'The entity ID is fixed. Add another provider to change it.'
        }
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('issuer')}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked || existing}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-url`}
        label="SSO sign-in URL"
        {...fields.field('signInUrl')}
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('signInUrl')}
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-certificate`}
        label="Signing certificate"
        {...fields.field('certificate')}
        description="Public RSA certificate, at least 2,048 bits. Enable SHA-256 or SHA-512 signatures and digests at the IdP."
      >
        {(control) => (
          <Textarea
            {...control}
            {...fields.control('certificate')}
            className="min-h-40 font-mono text-base md:text-xs"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked}
          />
        )}
      </LabelledField>
    </>
  );
}
export function SamlClaimFields({
  id,
  fields,
  locked,
}: Readonly<{ id: string; fields: TextFields; locked: boolean }>) {
  return (
    <Disclosure
      summary="Certificate rotation and attributes"
      appearance={{ tone: 'strong' }}
    >
      <div className="space-y-3">
        <LabelledField
          id={`${id}-next`}
          label="Additional signing certificate"
          {...fields.field('nextCertificate')}
          description="Optional overlap during certificate rotation. At least one certificate must be currently valid; only currently valid pinned certificates are accepted."
        >
          {(control) => (
            <Textarea
              {...control}
              {...fields.control('nextCertificate')}
              className="min-h-32 font-mono text-base md:text-xs"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={locked}
            />
          )}
        </LabelledField>
        <LabelledField
          id={`${id}-email`}
          label="Email attribute"
          {...fields.field('emailAttribute')}
          description="One scalar value in the signed assertion, from an exact verified domain."
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('emailAttribute')}
              disabled={locked}
            />
          )}
        </LabelledField>
        <LabelledField
          id={`${id}-display`}
          label="Display name attribute"
          {...fields.field('nameAttribute')}
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('nameAttribute')}
              disabled={locked}
            />
          )}
        </LabelledField>
      </div>
    </Disclosure>
  );
}
