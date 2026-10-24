import { useId, useState } from 'react';
import {
  oidcProviderCreateSchema,
  oidcConfigurationSchema,
  type FederationSettings,
  type FederationProtocol,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { SamlProviderForm } from './saml-form';
import { Disclosure } from '@/components/ui/disclosure';
type Organization = NonNullable<FederationSettings['organization']>;
type Provider = Extract<Organization['providers'][number], { kind: 'oidc' }>;
function initial(provider: Provider | undefined) {
  return {
    name: provider?.name ?? '',
    issuer: provider?.issuer ?? '',
    clientId: provider?.configuration.clientId ?? '',
    clientSecret: '',
    emailClaim: provider?.configuration.emailClaim ?? 'email',
    nameClaim: provider?.configuration.nameClaim ?? 'name',
  };
}
export function ProviderForm({
  provider,
  kind,
  ...props
}: ProviderEditorProps &
  Readonly<{
    provider?: Organization['providers'][number];
    kind?: FederationProtocol;
  }>) {
  if (provider?.kind === 'saml')
    return <SamlProviderForm {...props} provider={provider} />;
  if (provider === undefined && kind === 'saml')
    return <SamlProviderForm {...props} />;
  return (
    <OidcProviderForm
      {...props}
      {...(provider === undefined ? {} : { provider })}
    />
  );
}
function OidcProviderForm({
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
  const fields = useFieldValues(
    {
      name: (value: string) =>
        oidcProviderCreateSchema.shape.name.safeParse(value).success
          ? undefined
          : 'Enter a name of up to 128 characters.',
      issuer: (value: string) =>
        oidcProviderCreateSchema.shape.issuer.safeParse(value).success
          ? undefined
          : 'Use the exact public HTTPS issuer, without credentials, query or fragment.',
      clientId: (value: string) =>
        oidcConfigurationSchema.shape.clientId.safeParse(value).success
          ? undefined
          : 'Enter the provider client ID.',
      clientSecret: (value: string) => {
        if (provider !== undefined && value === '') {
          return undefined;
        }
        if (
          oidcProviderCreateSchema.shape.clientSecret.safeParse(value).success
        ) {
          return undefined;
        }
        return 'Enter a client secret of at most 8,192 UTF-8 bytes.';
      },
      emailClaim: (value: string) =>
        oidcConfigurationSchema.shape.emailClaim.safeParse(value).success
          ? undefined
          : 'Enter one email claim name.',
      nameClaim: (value: string) =>
        oidcConfigurationSchema.shape.nameClaim.safeParse(value).success
          ? undefined
          : 'Enter one display name claim.',
    },
    initial(provider),
  );
  const command = useFederationCommand(scope, onClose),
    locked = command.pending || command.uncertain,
    stale = organization.revision !== baseRevision;
  return (
    <ProviderDialog
      title={
        provider === undefined ? 'Add OIDC provider' : 'Edit OIDC provider'
      }
      description="Google Workspace, Microsoft Entra ID, Okta and generic OIDC use the same code flow. The client secret is encrypted on the API."
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
          const providerSubmissionBlocked =
            values === undefined || locked || stale || unavailable;
          if (providerSubmissionBlocked) return;
          const configuration = {
            clientId: values.clientId.trim(),
            emailClaim: values.emailClaim.trim(),
            nameClaim: values.nameClaim.trim(),
            jitEnabled: jit,
          };
          void command.send(
            provider === undefined
              ? {
                  kind: 'createProvider',
                  input: {
                    kind: 'oidc',
                    name: values.name.trim(),
                    issuer: values.issuer.trim(),
                    configuration,
                    clientSecret: values.clientSecret,
                    enabled,
                    expectedRevision: baseRevision,
                  },
                }
              : {
                  kind: 'updateProvider',
                  providerId: provider.id,
                  input: {
                    name: values.name.trim(),
                    configuration,
                    ...(values.clientSecret === ''
                      ? {}
                      : { clientSecret: values.clientSecret }),
                    enabled,
                    expectedRevision: baseRevision,
                  },
                },
          );
        }}
      >
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
            provider === undefined
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
              disabled={locked || provider !== undefined}
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
            provider === undefined
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
        <LabelledField
          id={`${id}-enabled`}
          label="Allow sign-in"
          description="Enable the provider, test every required domain, then turn on required SSO."
        >
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
        <Disclosure summary="Claim names" tone="strong">
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
