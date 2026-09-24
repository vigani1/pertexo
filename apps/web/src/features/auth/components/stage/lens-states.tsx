import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { AuthLens, AuthLensTitle, AuthStatusLine } from './auth-lens';

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
      <AuthStatusLine tone="attention" className="mt-5">
        {children}
      </AuthStatusLine>
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
