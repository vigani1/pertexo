import { useId, useState } from 'react';
import {
  oidcProviderCreateSchema,
  oidcConfigurationSchema,
  type FederationSettings,
} from '@pertexo/contracts';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
type Organization = NonNullable<FederationSettings['organization']>;
type Provider = Organization['providers'][number];
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
  scope,
  organization,
  provider,
  unavailable = false,
  onClose,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  provider?: Provider;
  unavailable?: boolean;
  onClose: () => void;
}>) {
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
      clientSecret: (value: string) =>
        provider !== undefined && value === ''
          ? undefined
          : oidcProviderCreateSchema.shape.clientSecret.safeParse(value).success
            ? undefined
            : 'Enter a client secret of at most 8,192 UTF-8 bytes.',
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
    <Dialog
      open
      disablePointerDismissal={locked}
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <DialogTitle>
          {provider === undefined ? 'Add OIDC provider' : 'Edit OIDC provider'}
        </DialogTitle>
        <DialogDescription>
          Google Workspace, Microsoft Entra ID, Okta and generic OIDC use the
          same code flow. The client secret is encrypted on the API.
        </DialogDescription>
        {unavailable ? (
          <Notice tone="warning">
            This provider was removed in another tab. Your inputs are kept, but
            it cannot be saved. Close the form to discard these edits.
          </Notice>
        ) : null}
        <form
          noValidate
          className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
          onSubmit={(event) => {
            event.preventDefault();
            const values = fields.validate();
            if (values === undefined || locked || stale || unavailable) return;
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
              <Input
                {...control}
                {...fields.control('name')}
                disabled={locked}
              />
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
            label="Allow new accounts"
            description="After verified SSO, create new accounts and grant linked workspaces their default roles. Existing manual roles stay unchanged; removed and suspended memberships are not restored."
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
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              Claim names
            </summary>
            <div className="mt-3 space-y-3">
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
          </details>
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
          <CommandFeedback command={command} />
          <p className="text-xs text-muted-foreground">
            Changing a required provider needs another tested provider first, or
            required SSO turned off. Provider changes end its existing sessions.
          </p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={locked}
            >
              Cancel
            </Button>
            <ProgressButton
              type="submit"
              pending={command.pending}
              pendingLabel="Saving…"
              disabled={locked || stale || unavailable}
            >
              Save provider
            </ProgressButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
