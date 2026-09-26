import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useParams,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { CopyButton } from '@/components/ui/copy-button';
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
import { Wordmark } from '@/features/auth/auth-stage.public';
import { knownWorkspaceName } from '@/features/workspaces/last-workspace.public';
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

const STILL_CONNECTING_MS = 2_000;

/** True once a cold start has taken long enough to say so. */
function useTakingLong(afterMs: number): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLong(true);
    }, afterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [afterMs]);
  return long;
}

/**
 * Cold start: the Core gathers itself while the session is confirmed. After
 * two seconds the line under it admits it's still connecting.
 */
function Boot({ message }: Readonly<{ message: string }>) {
  const long = useTakingLong(STILL_CONNECTING_MS);
  return (
    <FullScreen>
      <div
        role="status"
        className="mx-auto flex flex-col items-center gap-4 text-center"
      >
        <CoreOrb assemble state="idle" className="size-44" />
        <p className="font-display text-2xl [--display-optical-size:24] [--display-width:80%]">
          Pertexo<span className="text-secondary">.</span>
        </p>
        <p className="font-mono text-xs text-subtle-foreground">
          {long ? 'Still connecting…' : message}
        </p>
      </div>
    </FullScreen>
  );
}

/** The app root and public pages while the session is checked. */
export function BootPage() {
  return <Boot message="Checking your session…" />;
}

/** A public page that needs no session check, still loading. */
export function OpeningPage() {
  return <Boot message="Opening Pertexo…" />;
}

/** A workspace opening cold: named when this browser already knows it. */
export function WorkspaceBootPage() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams({ strict: false });
  const name =
    workspaceId === undefined
      ? undefined
      : knownWorkspaceName(queryClient, workspaceId);
  return <Boot message={`Opening ${name ?? 'your workspace'}…`} />;
}

const CENTRED = 'items-center text-center';

/** A whole-screen dead end: what happened and the one way out. */
function FullScreenState({
  art,
  title,
  description,
  action,
}: Readonly<{
  art: ReactNode;
  title: string;
  description: string;
  action: ReactNode;
}>) {
  return (
    <FullScreen>
      {/* The wordmark where the sign-in stage keeps it, so a dead end
          still says where you are. */}
      <div className="fixed top-6 left-6 z-10 min-[900px]:top-9 min-[900px]:left-11">
        <Wordmark />
      </div>
      <SystemState className={CENTRED}>
        <SystemStateArt>{art}</SystemStateArt>
        <SystemStateTitle>{title}</SystemStateTitle>
        <SystemStateDescription>{description}</SystemStateDescription>
        <SystemStateActions>{action}</SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}

const goHome = (
  <Link to="/" className={buttonVariants({ variant: 'primary' })}>
    Go to Pertexo
  </Link>
);

export function NotFoundPage() {
  return (
    <FullScreenState
      art={<LooseThread />}
      title="This page doesn’t exist"
      description="The address doesn’t lead anywhere in Pertexo. It may have been typed wrong or moved."
      action={goHome}
    />
  );
}

export function WorkspaceUnavailablePage() {
  return (
    <FullScreenState
      art={<BarredThread />}
      title="This workspace isn’t available"
      description="The link is wrong, or your account doesn’t have access to this workspace. Choose one you belong to instead."
      action={
        <Link
          to="/workspaces"
          className={buttonVariants({ variant: 'primary' })}
        >
          Choose a workspace
        </Link>
      }
    />
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
      Error ID
      <CopyButton value={reference} label="Copy error ID" display={reference} />
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
      <FullScreenState
        art={<LooseThread />}
        title="This doesn’t exist"
        description="It may have been removed, or your role doesn’t give you access to it."
        action={goHome}
      />
    );
  return (
    <FullScreen>
      <SystemState role="alert" className={CENTRED}>
        <SystemStateArt>
          <CoreOrb state="failed" className="size-36" />
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
