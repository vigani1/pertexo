import type { ReactNode } from 'react';
import {
  Link,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { CoreOrb } from '@/components/patterns/core-orb';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '@/components/patterns/system-state';
import {
  BarredThread,
  LooseThread,
} from '@/components/patterns/thread-illustrations';
import { isNotFound, supportReference } from '@/lib/api/api-error-copy';

function FullScreen({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main
      id="main"
      className="relative grid min-h-svh place-items-center overflow-hidden bg-background px-5"
    >
      <div className="ambient" aria-hidden="true" />
      <div className="relative z-10 w-full">{children}</div>
    </main>
  );
}

/** Cold start: the Core gathers itself while the session is confirmed. */
export function BootPage() {
  return (
    <FullScreen>
      <div
        role="status"
        className="mx-auto flex flex-col items-center gap-4 text-center"
      >
        <CoreOrb assemble state="idle" className="size-44" />
        <p className="font-heading text-2xl font-semibold tracking-[-0.03em]">
          Pertexo<span className="text-secondary">.</span>
        </p>
        <p className="font-mono text-xs text-subtle-foreground">
          Opening your workspace…
        </p>
      </div>
    </FullScreen>
  );
}

export function NotFoundPage() {
  return (
    <FullScreen>
      <SystemState>
        <SystemStateArt>
          <LooseThread />
        </SystemStateArt>
        <SystemStateTitle>This page doesn’t exist</SystemStateTitle>
        <SystemStateDescription>
          The address doesn’t lead anywhere in Pertexo. It may have been typed
          wrong or moved.
        </SystemStateDescription>
        <SystemStateActions>
          <Link to="/" className={buttonVariants({ variant: 'primary' })}>
            Go to Pertexo
          </Link>
        </SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}

export function WorkspaceUnavailablePage() {
  return (
    <FullScreen>
      <SystemState>
        <SystemStateArt>
          <BarredThread />
        </SystemStateArt>
        <SystemStateTitle>This workspace isn’t available</SystemStateTitle>
        <SystemStateDescription>
          The link is wrong, or your account doesn’t have access to this
          workspace. Choose one you belong to instead.
        </SystemStateDescription>
        <SystemStateActions>
          <Link
            to="/workspaces"
            className={buttonVariants({ variant: 'primary' })}
          >
            Choose a workspace
          </Link>
        </SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}

/** In-shell: a workflow or run that doesn't exist or isn't visible. */
export function ResourceNotFound({
  resource,
  children,
}: Readonly<{ resource: 'workflow' | 'run'; children: ReactNode }>) {
  return (
    <SystemState>
      <SystemStateArt>
        <LooseThread />
      </SystemStateArt>
      <SystemStateTitle>This {resource} doesn’t exist</SystemStateTitle>
      <SystemStateDescription>
        It may have been removed, or your role doesn’t give you access to it.
      </SystemStateDescription>
      <SystemStateActions>{children}</SystemStateActions>
    </SystemState>
  );
}

function ErrorReference({ reference }: Readonly<{ reference: string }>) {
  return (
    <p className="flex items-center gap-2 font-mono text-xs text-subtle-foreground">
      Error ID {reference}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy error ID"
        onClick={() => void navigator.clipboard.writeText(reference)}
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </p>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const reference = supportReference(error);
  async function retry() {
    await router.invalidate();
    reset();
  }
  if (isNotFound(error))
    return (
      <FullScreen>
        <SystemState>
          <SystemStateArt>
            <LooseThread />
          </SystemStateArt>
          <SystemStateTitle>This doesn’t exist</SystemStateTitle>
          <SystemStateDescription>
            It may have been removed, or your role doesn’t give you access to
            it.
          </SystemStateDescription>
          <SystemStateActions>
            <Link to="/" className={buttonVariants({ variant: 'primary' })}>
              Go to Pertexo
            </Link>
          </SystemStateActions>
        </SystemState>
      </FullScreen>
    );
  return (
    <FullScreen>
      <SystemState role="alert">
        <SystemStateArt>
          <CoreOrb state="failed" className="size-24" />
        </SystemStateArt>
        <SystemStateTitle>Something broke on our side</SystemStateTitle>
        <SystemStateDescription>
          Your work is safe. Try again, and if it keeps happening, send us the
          error ID.
        </SystemStateDescription>
        {reference === undefined ? null : (
          <ErrorReference reference={reference} />
        )}
        <SystemStateActions>
          <Button variant="primary" onClick={() => void retry()}>
            Try again
          </Button>
        </SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}
