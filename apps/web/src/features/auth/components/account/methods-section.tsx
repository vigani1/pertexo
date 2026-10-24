import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import type { AccountSecurityResponse } from '@pertexo/contracts';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { useUnlinkAccountMethod } from '../../data/account-security.mutations';
import { ProviderMark } from '../social/provider-button';
import { isSocialProvider, providerName } from '../../model/social-provider';
import { accountCommandFailure } from '../../model/account/failure';
import { AccountSection, FreshSignInLink } from './section';
import { LinkProviderDialog } from './link-provider-dialog';

type Method = AccountSecurityResponse['methods'][number];

function methodName(method: Method): string {
  if (method.kind === 'password') {
    return 'Password';
  }
  if (method.kind === 'organization') {
    return method.label ?? 'Organization SSO';
  }
  return providerName(method.provider ?? 'Provider');
}

function MethodMark({ method }: Readonly<{ method: Method }>) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-surface-ink/10 bg-surface-ink/[0.035] text-muted-foreground">
      {isSocialProvider(method.provider) ? (
        <ProviderMark provider={method.provider} />
      ) : (
        <KeyRoundIcon aria-hidden="true" className="size-4" />
      )}
    </span>
  );
}

/** The ways this account signs in, with add and (confirmed) remove. */
export function AccountMethodsSection({
  apiClient,
  userId,
  security,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  security: AccountSecurityResponse;
  navigateToProvider?: (url: string) => void;
}>) {
  const [adding, setAdding] = useState(false);
  const [methodToRemove, setMethodToRemove] = useState<Method>();
  const unlink = useUnlinkAccountMethod(apiClient, userId);
  const notifications = useNotifications();
  const connected = new Set(security.methods.map((method) => method.provider));
  const linkable = security.availableProviders.filter(
    (provider) => !connected.has(provider),
  );
  const canLink = security.methods.some(
    (method) => method.kind === 'password' || isSocialProvider(method.provider),
  );

  function closeRemoval() {
    if (unlink.isPending) return;
    unlink.reset();
    setMethodToRemove(undefined);
  }

  return (
    <AccountSection
      title="Sign-in methods"
      description="Every way you can sign in to Pertexo."
      action={
        linkable.length === 0 ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canLink}
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add a sign-in method
          </Button>
        )
      }
    >
      {linkable.length > 0 && !canLink ? (
        <p className="text-sm text-muted-foreground">
          Add a password before connecting another sign-in method. Required
          organization SSO still applies.
        </p>
      ) : null}
      <SignInMethods
        methods={security.methods}
        email={security.email}
        pending={unlink.isPending}
        onRemove={(method) => {
          unlink.reset();
          setMethodToRemove(method);
        }}
      />
      {adding ? (
        <LinkProviderDialog
          key={userId}
          apiClient={apiClient}
          providers={linkable}
          methods={security.methods}
          navigateToProvider={navigateToProvider}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
      <ConfirmDialog
        state={{
          open: methodToRemove !== undefined,
          onOpenChange: (open) => {
            if (!open) closeRemoval();
          },
          locked: unlink.isPending,
        }}
        title="Remove sign-in method?"
        description={`You won’t be able to sign in with ${
          methodToRemove === undefined ? 'it' : methodName(methodToRemove)
        } any more. Other devices will be signed out; this one stays signed in.`}
        onSubmit={async () => {
          if (methodToRemove === undefined) return;
          const name = methodName(methodToRemove);
          await unlink.mutateAsync(methodToRemove.id);
          setMethodToRemove(undefined);
          notifications.success({ title: `${name} removed` });
        }}
        submitDisabled={unlink.isPending || methodToRemove === undefined}
        footer={
          <ConfirmationFooter>
            <DialogClose
              disabled={unlink.isPending}
              render={<Button type="button" variant="ghost" />}
            >
              Keep method
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="destructive"
              pending={unlink.isPending}
              pendingLabel="Removing…"
              disabled={methodToRemove === undefined}
            >
              Remove method
            </ProgressButton>
          </ConfirmationFooter>
        }
      >
        <ConfirmationDetails
          error={removalFailure(unlink.error)}
          errorAction={<FreshSignInLink error={unlink.error} />}
        />
      </ConfirmDialog>
    </AccountSection>
  );
}

function removalFailure(error: unknown): string | undefined {
  if (error === null) return undefined;
  const methodMustRemain =
    isApiError(error) && (error.status === 400 || error.status === 409);
  if (methodMustRemain)
    return 'This method can’t be removed. Keep at least one way to sign in.';
  return accountCommandFailure(error, 'removing this method');
}

function SignInMethods({
  methods,
  email,
  pending,
  onRemove,
}: Readonly<{
  methods: readonly Method[];
  email: string;
  pending: boolean;
  onRemove: (method: Method) => void;
}>) {
  const onlyMethod = methods.length <= 1;
  return (
    <ul
      aria-label="Sign-in methods"
      className="flex flex-col divide-y divide-border"
    >
      {methods.map((method) => (
        <li
          key={method.id}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0"
        >
          <div className="flex min-w-0 items-center gap-3">
            <MethodMark method={method} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{methodName(method)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {method.kind === 'password' ? email : 'Connected account'}
              </p>
            </div>
          </div>
          {/* The only way in can't be removed, so it gets a reason
                instead of a button that never works. */}
          {onlyMethod ? (
            <span className="text-xs text-subtle-foreground">
              Your only way to sign in
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Remove ${methodName(method)}`}
              disabled={pending}
              onClick={() => {
                onRemove(method);
              }}
            >
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
