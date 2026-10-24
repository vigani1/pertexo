import { SamlIdentityFields, SamlClaimFields } from './fields/saml';
import { useId, useState } from 'react';
import {
  samlProviderCreateSchema,
  samlConfigurationSchema,
  type FederationSettings,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { useFederationCommand } from '../../data/use-command';
import {
  ProviderDialog,
  ProviderFooter,
  type ProviderEditorProps,
} from './editor';
type Provider = Extract<
  NonNullable<FederationSettings['organization']>['providers'][number],
  { kind: 'saml' }
>;
function initial(provider: Provider | undefined) {
  return {
    name: provider?.name ?? '',
    issuer: provider?.issuer ?? '',
    signInUrl: provider?.configuration.signInUrl ?? '',
    certificate: provider?.configuration.certificates[0] ?? '',
    nextCertificate: provider?.configuration.certificates[1] ?? '',
    emailAttribute: provider?.configuration.emailAttribute ?? 'email',
    nameAttribute: provider?.configuration.nameAttribute ?? 'name',
  };
}
export function SamlProviderForm({
  scope,
  organization,
  provider,
  unavailable = false,
  onClose,
}: ProviderEditorProps & Readonly<{ provider?: Provider }>) {
  const id = useId();
  const [baseRevision, setBaseRevision] = useState(organization.revision),
    [enabled, setEnabled] = useState(provider?.enabled ?? false),
    [jit, setJit] = useState(provider?.configuration.jitEnabled ?? false);
  const fields = useFieldValues(SAML_FIELD_RULES, initial(provider));
  const command = useFederationCommand(scope, onClose),
    locked = command.pending || command.uncertain,
    stale = organization.revision !== baseRevision;
  return (
    <ProviderDialog
      title={
        provider === undefined ? 'Add SAML provider' : 'Edit SAML provider'
      }
      description="Use SP-initiated Redirect requests and POST responses. Your IdP must sign both the response and assertion, with a persistent, immutable NameID. No private key is uploaded."
      locked={locked}
      unavailable={unavailable}
      onClose={onClose}
    >
      <form
        noValidate
        className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
        onSubmit={(event) => {
          event.preventDefault();
          const values = fields.validate();
          const samlSubmissionBlocked =
            values === undefined || locked || stale || unavailable;
          if (samlSubmissionBlocked) return;
          const configuration = {
            signInUrl: values.signInUrl.trim(),
            certificates: [
              values.certificate.trim(),
              ...(values.nextCertificate.trim() === ''
                ? []
                : [values.nextCertificate.trim()]),
            ],
            emailAttribute: values.emailAttribute.trim(),
            nameAttribute: values.nameAttribute.trim(),
            jitEnabled: jit,
          };
          const common = {
            kind: 'saml' as const,
            name: values.name.trim(),
            configuration,
            enabled,
            expectedRevision: baseRevision,
          };
          void command.send(
            provider === undefined
              ? {
                  kind: 'createProvider',
                  input: { ...common, issuer: values.issuer.trim() },
                }
              : {
                  kind: 'updateProvider',
                  providerId: provider.id,
                  input: common,
                },
          );
        }}
      >
        <SamlIdentityFields
          id={id}
          fields={fields}
          locked={locked}
          existing={provider !== undefined}
        />
        <LabelledField id={`${id}-enabled`} label="Allow sign-in">
          {(control) => (
            <Checkbox
              {...control}
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={locked}
            />
          )}
        </LabelledField>
        <LabelledField
          id={`${id}-jit`}
          label="Allow unprovisioned new accounts"
          description="Allow verified SSO to create accounts that are not in the directory. Active directory-provisioned people may sign in with this off. Existing manual roles stay unchanged; removed and suspended manual memberships are not restored."
        >
          {(control) => (
            <Checkbox
              {...control}
              checked={jit}
              onCheckedChange={setJit}
              disabled={locked}
            />
          )}
        </LabelledField>
        <SamlClaimFields id={id} fields={fields} locked={locked} />
        {stale ? (
          <Notice
            tone="warning"
            action={
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => {
                  fields.reset(initial(provider));
                  setEnabled(provider?.enabled ?? false);
                  setJit(provider?.configuration.jitEnabled ?? false);
                  setBaseRevision(organization.revision);
                  command.reset();
                }}
              >
                Reload provider
              </Button>
            }
          >
            Organization settings changed. Your edits are kept. Reloading
            replaces this form with the current settings.
          </Notice>
        ) : null}
        <ProviderFooter
          command={command}
          disabled={stale || unavailable}
          onClose={onClose}
        />
      </form>
    </ProviderDialog>
  );
}

const SAML_FIELD_RULES = {
  name: (value: string) =>
    samlProviderCreateSchema.shape.name.safeParse(value).success
      ? undefined
      : 'Enter a name of up to 128 characters.',
  issuer: (value: string) =>
    samlProviderCreateSchema.shape.issuer.safeParse(value).success
      ? undefined
      : 'Copy the exact IdP entity ID (HTTP, HTTPS or URN).',
  signInUrl: (value: string) =>
    samlConfigurationSchema.shape.signInUrl.safeParse(value).success
      ? undefined
      : 'Enter the HTTPS sign-in URL without credentials or a fragment.',
  certificate: (value: string) =>
    samlConfigurationSchema.shape.certificates.element.safeParse(value).success
      ? undefined
      : 'Paste a PEM signing certificate of at most 16,384 characters.',
  nextCertificate: (value: string) =>
    value.trim() === '' ||
    samlConfigurationSchema.shape.certificates.element.safeParse(value).success
      ? undefined
      : 'Paste one PEM certificate or leave this empty.',
  emailAttribute: (value: string) =>
    samlConfigurationSchema.shape.emailAttribute.safeParse(value).success
      ? undefined
      : 'Enter one email attribute name.',
  nameAttribute: (value: string) =>
    samlConfigurationSchema.shape.nameAttribute.safeParse(value).success
      ? undefined
      : 'Enter one display name attribute name.',
};
