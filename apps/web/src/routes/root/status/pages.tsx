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
import { ProgressButton } from '@/components/ui/progress-button';
import { buttonVariants } from '@/components/ui/button-variants';
import { CoreOrb } from '@/components/patterns/core/orb';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '@/components/patterns/states/system-state';
import {
  BarredThread,
  LooseThread,
} from '@/components/patterns/states/thread-illustrations';
import { Wordmark } from '@/features/auth/auth-stage.public';
import { knownWorkspaceName } from '@/features/workspaces/last-workspace.public';
import { isApiError } from '@/lib/api/error';
import {
  isForbidden,
  isNotFound,
  retryAfterSeconds,
  supportReference,
} from '@/lib/api/error-copy';
import { useNow } from '@/lib/hooks/use-now';

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
        <CoreOrb assemble state="idle" className="size-60 sm:size-72" />
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
  if (isForbidden(error))
    return (
      <FullScreenState
        art={<BarredThread />}
        title="You don’t have access to this"
        description="Your role here doesn’t include this page. A workspace owner or admin can change it."
        action={goHome}
      />
    );
  if (isApiError(error) && error.status === 429)
    return (
      <RateLimited
        // Each refusal brings its own Retry-After, so its countdown starts over.
        key={error.requestId ?? 'rate-limited'}
        seconds={retryAfterSeconds(error) ?? 0}
        onRetry={() => void retry()}
      />
    );
  if (isApiError(error) && error.kind === 'network')
    return (
      <Unreachable
        orb="idle"
        title="Pertexo can’t be reached"
        description="Check your internet connection, then try again. Your work is safe."
        onRetry={() => void retry()}
      />
    );
  if (isApiError(error) && error.kind === 'timeout')
    return (
      <Unreachable
        orb="waiting"
        title="Pertexo is taking too long"
        description="It may be busy for a moment. Try again; your work is safe."
        onRetry={() => void retry()}
      />
    );
  const reference = supportReference(error);
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

/** Nothing is broken, so the Core stays calm instead of turning red. */
function Unreachable({
  orb,
  title,
  description,
  onRetry,
}: Readonly<{
  orb: 'idle' | 'waiting';
  title: string;
  description: string;
  onRetry: () => void;
}>) {
  return (
    <FullScreen>
      <SystemState role="alert" className={CENTRED}>
        <SystemStateArt>
          <CoreOrb state={orb} className="size-36" />
        </SystemStateArt>
        <SystemStateTitle>{title}</SystemStateTitle>
        <SystemStateDescription>{description}</SystemStateDescription>
        <SystemStateActions>
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}

/** Retrying before the server's Retry-After only earns another refusal. */
function RateLimited({
  seconds,
  onRetry,
}: Readonly<{ seconds: number; onRetry: () => void }>) {
  const [deadline] = useState(() => Date.now() + seconds * 1_000);
  const now = useNow({
    intervalMs: 250,
    enabled: seconds > 0,
    untilMs: deadline,
  });
  const waitSeconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return (
    <FullScreen>
      <SystemState role="alert" className={CENTRED}>
        <SystemStateArt>
          <CoreOrb state="waiting" className="size-36" />
        </SystemStateArt>
        <SystemStateTitle>Too many requests</SystemStateTitle>
        <SystemStateDescription>
          Pertexo is pacing requests from this browser. Your work is safe, and
          you can try again in a moment.
        </SystemStateDescription>
        <SystemStateActions>
          <ProgressButton
            variant="primary"
            pendingLabel="Trying again…"
            waitSeconds={waitSeconds}
            onClick={onRetry}
          >
            Try again
          </ProgressButton>
        </SystemStateActions>
      </SystemState>
    </FullScreen>
  );
}
