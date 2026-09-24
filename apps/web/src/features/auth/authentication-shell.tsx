import type { ReactNode } from 'react';

export function AuthenticationShell({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <main
      id="main"
      className="auth-stage relative grid min-h-svh place-items-center overflow-hidden px-5 py-10"
    >
      <div className="process-trace" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="relative z-10 flex w-full max-w-[30rem] flex-col gap-7">
        <header className="text-center">
          <p className="font-mono text-xs tracking-[0.22em] text-secondary">
            PERTEXO / CONTROL PLANE
          </p>
          <p
            translate="no"
            className="mt-3 font-heading text-4xl font-semibold tracking-tight text-primary sm:text-5xl"
          >
            Pertexo<span className="text-secondary">.</span>
          </p>
          <p className="mt-2 text-base text-muted-foreground">
            Precision workflow operations
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}
