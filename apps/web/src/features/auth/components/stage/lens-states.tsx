import type { AuthenticationCapabilitiesResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { AuthLens, AuthLensFooter, AuthLensTitle } from './auth-lens';
import { Notice } from '@/components/ui/notice';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from '../../auth.queries';

/**
 * The lens while Pertexo checks which sign-in methods are available. The
 * page's title is already real; only what depends on the answer shimmers.
 */
export function LensLoading({
  label,
  title,
}: Readonly<{ label: string; title: string }>) {
  return (
    <AuthLens pending aria-labelledby="lens-loading-title">
      <AuthLensTitle id="lens-loading-title">{title}</AuthLensTitle>
      <div role="status" className="mt-4 flex flex-col gap-4">
        <span className="sr-only">{label}</span>
        <Skeleton className="h-3 w-56" />
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-10 w-full rounded-md" />
          <SkeletonThread order={1} className="w-3/4" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
        <Skeleton className="mt-2 h-11 w-full rounded-md" />
      </div>
    </AuthLens>
  );
}

/** A dead end with one honest sentence and, when it may help, a retry. */
export function LensUnavailable({
  id,
  title,
  children,
  onRetry,
  retrying = false,
  footer,
}: Readonly<{
  id: string;
  title: string;
  children: ReactNode;
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
  footer?: ReactNode;
}>) {
  return (
    <AuthLens pending={retrying} aria-labelledby={id}>
      <AuthLensTitle id={id}>{title}</AuthLensTitle>
      <Notice tone="warning" className="mt-5">
        {children}
      </Notice>
      {onRetry === undefined ? null : (
        <Button
          type="button"
          variant="default"
          size="lg"
          className="mt-5 w-full"
          disabled={retrying}
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
      {footer}
    </AuthLens>
  );
}

/**
 * Password sign-up, recovery and reset: the loading lens while Pertexo reads
 * which sign-in methods it offers, a dead end with the way back to sign in
 * (and a retry when the read failed) when passwords can't be used here, and
 * otherwise `children` with the capabilities.
 */
export function PasswordCapabilityGate({
  apiClient,
  id,
  title,
  loadingLabel,
  unavailable,
  children,
}: Readonly<{
  apiClient: ApiClient;
  id: string;
  title: string;
  loadingLabel: string;
  /** Why the page can't be used, e.g. "Password reset is not available right now." */
  unavailable: string;
  children: (capabilities: AuthenticationCapabilitiesResponse) => ReactNode;
}>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  if (capabilities.isPending)
    return <LensLoading title={title} label={loadingLabel} />;
  if (capabilities.isError || !capabilities.data.password.enabled)
    return (
      <LensUnavailable
        id={id}
        title={title}
        retrying={capabilities.isFetching}
        {...(capabilities.isError
          ? { onRetry: () => void capabilities.refetch() }
          : {})}
        footer={
          <AuthLensFooter>
            <Link to="/login">Back to sign in</Link>
          </AuthLensFooter>
        }
      >
        {unavailable}
      </LensUnavailable>
    );
  return children(capabilities.data);
}
