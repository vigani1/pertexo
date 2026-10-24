import { useId, useState } from 'react';
import {
  samlProviderCreateSchema,
  samlConfigurationSchema,
  type FederationSettings,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { Disclosure } from '@/components/ui/disclosure';
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
  const fields = useFieldValues(
    {
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
        samlConfigurationSchema.shape.certificates.element.safeParse(value)
          .success
          ? undefined
          : 'Paste a PEM signing certificate of at most 16,384 characters.',
      nextCertificate: (value: string) =>
        value.trim() === '' ||
        samlConfigurationSchema.shape.certificates.element.safeParse(value)
          .success
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
    },
    initial(provider),
  );
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
            provider === undefined
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
              disabled={locked || provider !== undefined}
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
        <Disclosure summary="Certificate rotation and attributes" tone="strong">
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
