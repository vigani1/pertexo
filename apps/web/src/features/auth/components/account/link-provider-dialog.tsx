import { DialogFooter } from '@/components/ui/dialog';
import {
  authenticationProviderSchema,
  type AccountSecurityLinkStartRequest,
  type AccountSecurityResponse,
} from '@pertexo/contracts';
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
import { isApiError, isSessionExpired } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { useAccountLinkStart } from '../../data/account-security/account-security.mutations';
import { currentPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '@/components/ui/progress-button';
import { SocialProviderGrid } from '../social/provider-grid';
import {
  isSocialProvider,
  providerName,
  type SocialProvider,
} from '../../model/social-provider';
import { Notice } from '@/components/ui/notice';
import { FRESH_SIGN_IN_WINDOW_MILLIS } from '@pertexo/workflow-model';
import { formatTimeSpan } from '@/lib/format/time';

type Method = AccountSecurityResponse['methods'][number];

function methodLabel(method: Method): string {
  return method.kind === 'password'
    ? 'Password'
    : providerName(method.provider ?? 'provider');
}

// Link start's refusals, each named by its code.
const LINK_REFUSALS: Partial<Record<string, string>> = {
  'auth.email_not_verified':
    'Verify your email address before adding a sign-in method. Check your inbox for the link.',
  'auth.invalid_password':
    'That didn’t confirm it’s you. Check your current password and try again.',
  // The method picked to confirm was removed since this dialog opened.
  'auth.authentication_changed':
    'That sign-in method is no longer on your account. Close this and pick another one.',
};

function linkFailure(error: unknown, provider: string): string {
  if (isApiError(error)) {
    if (isSessionExpired(error)) return 'Your session ended. Sign in again.';
    const refusal = LINK_REFUSALS[error.problem?.code ?? ''];
    if (refusal !== undefined) return refusal;
    // Link start's only other 403 is a request it couldn't verify (CSRF).
    if (error.status === 403)
      return 'We couldn’t verify this request. Reload the page and try again.';
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
        className="text-label font-semibold text-foreground/85"
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
 * within the fresh sign-in window, and a matching email never links accounts
 * by itself.
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
    (method) =>
      method.kind === 'password' ||
      (isSocialProvider(method.provider) && method.provider !== target),
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
  const link = useAccountLinkStart(apiClient);
  const { pending } = link;
  const failure =
    link.failure === undefined || target === undefined
      ? undefined
      : linkFailure(link.failure, providerName(target));

  function close() {
    link.abort();
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
    const outcome = await link.run({ provider: target, existingMethod });
    if (outcome.kind !== 'done') return;
    fields.reset();
    navigateToProvider(outcome.value);
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
          {`Confirm it’s you, then we send you to the provider to connect it. Both steps need to finish within ${formatTimeSpan(FRESH_SIGN_IN_WINDOW_MILLIS / 1_000)}.`}
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
                  link.clearFailure();
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
            ) : null}
            <MethodConfirmationHint source={source} />
            {failure === undefined ? null : (
              <Notice tone="destructive">{failure}</Notice>
            )}
            <DialogFooter className="mt-2">
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
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MethodConfirmationHint({
  source,
}: Readonly<{ source: Method | undefined }>) {
  if (source === undefined || source.kind === 'password') return null;
  return (
    <p className="text-sm text-muted-foreground">
      You’ll sign in with {methodLabel(source)} first to confirm it’s you.
    </p>
  );
}
