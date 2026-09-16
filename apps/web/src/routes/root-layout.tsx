import {
  Link,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';

export function RootLayout() {
  return (
    <>
      <a
        href="#main"
        className="fixed left-4 top-4 z-50 -translate-y-16 rounded-md bg-primary p-3 text-primary-foreground opacity-0 transition-[transform,opacity] focus:translate-y-0 focus:opacity-100 motion-reduce:transition-none"
      >
        Skip to content
      </a>
      <Outlet />
    </>
  );
}

export function PendingPage() {
  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      <div
        role="status"
        className="flex items-center gap-3 text-muted-foreground"
      >
        <span className="session-pulse" aria-hidden="true" />
        Checking your session…
      </div>
    </main>
  );
}

export function WorkspaceUnavailablePage() {
  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      <section className="flex max-w-lg flex-col items-start gap-5">
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          WORKSPACE UNAVAILABLE
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          This workspace is not available
        </h1>
        <p className="leading-relaxed text-muted-foreground">
          The address is invalid or your current account does not have access.
          Choose one of your available workspaces instead.
        </p>
        <Link to="/workspaces" className={buttonVariants()}>
          Choose a workspace
        </Link>
      </section>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      <section className="flex max-w-lg flex-col items-start gap-5">
        <h1 className="text-4xl font-semibold text-balance">Page not found</h1>
        <p className="text-muted-foreground">
          This address does not match an available Pertexo screen.
        </p>
        <Link to="/" className={buttonVariants({ variant: 'outline' })}>
          Return to Pertexo
        </Link>
      </section>
    </main>
  );
}

export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter();
  async function retry() {
    await router.invalidate();
    reset();
  }
  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      <section
        className="flex max-w-lg flex-col items-start gap-5"
        role="alert"
      >
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          CONNECTION INTERRUPTED
        </p>
        <h1 className="text-4xl font-semibold text-balance">
          Pertexo could not load this screen
        </h1>
        <p className="leading-relaxed text-muted-foreground">
          Check your connection and try again. Your browser session has not been
          changed.
        </p>
        <Button onClick={() => void retry()}>Try again</Button>
      </section>
    </main>
  );
}
