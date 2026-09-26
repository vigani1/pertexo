import {
  authenticationProviderSchema,
  type AccountSecurityLinkStartRequest,
  type AccountSecurityResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import { startAccountLink } from '../../account-security.api';
import { currentPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '@/components/ui/progress-button';
import { useLatestRequest } from '../../use-latest-request';
import { SocialProviderGrid } from '../social/social-provider-grid';
import { providerName, type SocialProvider } from '../../model/social-provider';
import { Notice } from '@/components/ui/notice';

type Method = AccountSecurityResponse['methods'][number];

function methodLabel(method: Method): string {
  return method.kind === 'password'
    ? 'Password'
    : providerName(method.provider ?? 'provider');
}

function linkFailure(error: unknown, provider: string): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session ended. Sign in again.';
    if (error.status === 403)
      return 'That didn’t confirm it’s you. Check your current password and try again.';
    if (error.status === 409)
      return `${provider} is already connected. Close this and check your methods.`;
    if (error.status === 503)
      return `${provider} is unavailable right now. Try again later.`;
  }
  return 'Connecting couldn’t start. Your sign-in methods didn’t change.';
}

/** "Confirm with": which existing method proves it's you. */
function SourcePicker({
  sources,
  source,
  disabled,
  onChange,
}: Readonly<{
  sources: readonly Method[];
  source: Method | undefined;
  disabled: boolean;
  onChange: (sourceId: string) => void;
}>) {
  return (
    <div className="flex flex-col gap-2">
      <span
        id="link-source-label"
        className="text-[0.8rem] font-semibold text-foreground/85"
      >
        Confirm with
      </span>
      <ToggleGroup
        aria-labelledby="link-source-label"
        value={source === undefined ? [] : [source.id]}
        onValueChange={(value) => {
          const [next] = value;
          if (typeof next === 'string') onChange(next);
        }}
      >
        {sources.map((method) => (
          <ToggleGroupItem
            key={method.id}
            value={method.id}
            disabled={disabled}
          >
            {methodLabel(method)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * Add a sign-in method: pick the provider, confirm it's you with a method
 * you already have, then continue to the provider. Both proofs must finish
 * within five minutes, and a matching email never links accounts by itself.
 */
export function LinkProviderDialog({
  apiClient,
  providers,
  methods,
  onClose,
  navigateToProvider,
}: Readonly<{
  apiClient: ApiClient;
  providers: readonly SocialProvider[];
  methods: readonly Method[];
  onClose(): void;
  navigateToProvider(url: string): void;
}>) {
  const [target, setTarget] = useState<SocialProvider | undefined>(
    providers.length === 1 ? providers[0] : undefined,
  );
  const sources = methods.filter(
    (method) => method.kind === 'password' || method.provider !== target,
  );
  const [sourceId, setSourceId] = useState(sources[0]?.id);
  const source = sources.find((method) => method.id === sourceId) ?? sources[0];
  const confirmsWithPassword = source?.kind === 'password';
  const fields = useFieldValues(
    {
      password: (value) =>
        confirmsWithPassword ? currentPasswordProblem(value) : undefined,
    },
    { password: '' },
  );
  const requests = useLatestRequest();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  function close() {
    requests.abort();
    fields.reset();
    onClose();
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || target === undefined || source === undefined) return;
    const values = fields.validate();
    if (values === undefined) return;
    const existingMethod: AccountSecurityLinkStartRequest['existingMethod'] =
      source.kind === 'password'
        ? { kind: 'password', password: values.password }
        : {
            kind: 'social',
            provider: authenticationProviderSchema.parse(source.provider),
          };
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    try {
      const url = await startAccountLink(
        apiClient,
        { provider: target, existingMethod },
        request.signal,
      );
      if (!request.isCurrent()) return;
      fields.reset();
      navigateToProvider(url);
    } catch (error) {
      if (request.isCurrent())
        setFailure(linkFailure(error, providerName(target)));
    } finally {
      if (request.finish()) setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent aria-busy={pending || undefined}>
        <DialogTitle>Add a sign-in method</DialogTitle>
        <DialogDescription>
          Confirm it’s you, then we send you to the provider to connect it. Both
          steps need to finish within five minutes.
        </DialogDescription>
        {target === undefined ? (
          <div className="mt-6">
            <SocialProviderGrid
              label="Choose a provider"
              providers={providers}
              disabled={false}
              onSelect={setTarget}
            />
          </div>
        ) : (
          <form
            noValidate
            className="mt-6 flex flex-col gap-4"
            onSubmit={(event) => void submit(event)}
          >
            {sources.length > 1 ? (
              <SourcePicker
                sources={sources}
                source={source}
                disabled={pending}
                onChange={(next) => {
                  setSourceId(next);
                  fields.reset();
                  setFailure(undefined);
                }}
              />
            ) : null}
            {confirmsWithPassword ? (
              <PasswordField
                id="link-current-password"
                label="Current password"
                autoComplete="current-password"
                disabled={pending}
                {...fields.field('password')}
                {...fields.control('password')}
              />
            ) : source === undefined ? null : (
              <p className="text-sm text-muted-foreground">
                You’ll sign in with {methodLabel(source)} first to confirm it’s
                you.
              </p>
            )}
            {failure === undefined ? null : (
              <Notice tone="destructive">{failure}</Notice>
            )}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <ProgressButton
                type="submit"
                variant="primary"
                pending={pending}
                pendingLabel="Confirming…"
                disabled={source === undefined}
              >
                Continue to {providerName(target)}
              </ProgressButton>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
