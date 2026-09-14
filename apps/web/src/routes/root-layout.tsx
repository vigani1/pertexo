import {
  Link,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { Button, buttonVariants } from '@/components/ui/button';

export function RootLayout() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded-md focus:bg-primary focus:p-3 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="mx-auto flex max-w-5xl items-center justify-between border-b px-6 py-6">
        <Link
          to="/"
          className="font-heading text-xl font-semibold tracking-tight"
        >
          pertexo<span className="text-primary">.</span>
        </Link>
        <span className="font-mono text-xs text-muted-foreground">
          FRONTEND FOUNDATION
        </span>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-5xl px-6 py-12 sm:py-20"
      >
        <Outlet />
      </main>
    </>
  );
}

export function NotFoundPage() {
  return (
    <section className="flex flex-col items-start gap-5">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">
        Only the frontend foundation is available right now.
      </p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Back to foundation
      </Link>
    </section>
  );
}

export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter();
  async function retry() {
    await router.invalidate();
    reset();
  }
  return (
    <section className="flex flex-col items-start gap-5" role="alert">
      <h1 className="text-3xl font-semibold">This page could not load</h1>
      <p className="text-muted-foreground">
        Try again. If the problem continues, reload the page.
      </p>
      <Button
        onClick={() => {
          void retry();
        }}
      >
        Try again
      </Button>
    </section>
  );
}
