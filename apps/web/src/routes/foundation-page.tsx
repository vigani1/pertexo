import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function FoundationPage() {
  const [tested, setTested] = useState(false);
  return (
    <div className="flex flex-col gap-12">
      <section className="flex max-w-2xl flex-col gap-5">
        <p className="font-mono text-xs tracking-widest text-secondary">
          PERTEXO / WEB
        </p>
        <h1 className="text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
          The foundation is ready.
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          A small starting point for the web app. Your visual language is here;
          product screens, authentication and workflows come next.
        </p>
      </section>
      <section
        aria-labelledby="foundation-title"
        className="flex flex-col gap-6"
      >
        <h2 id="foundation-title" className="text-xl font-semibold">
          Clear responsibilities
        </h2>
        <dl className="grid gap-6 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <dt className="font-medium">Routes &amp; providers</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">
              Navigation and shared app setup. TanStack Query will own saved
              server data.
            </dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt className="font-medium">Feature modules</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">
              Added one at a time. Editing state stays separate from the server
              cache.
            </dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt className="font-medium">Shared UI &amp; theme</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">
              Accessible primitives, semantic colors and locally served fonts.
            </dd>
          </div>
        </dl>
      </section>
      <section
        aria-labelledby="interaction-title"
        className="glass-panel flex flex-col items-start gap-4 rounded-xl p-6"
      >
        <h2 id="interaction-title" className="text-lg font-semibold">
          A small interaction check
        </h2>
        <p className="text-sm text-muted-foreground">
          This only checks local React state and the button primitive. Nothing
          is sent to the backend.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            onClick={() => {
              setTested((value) => !value);
            }}
          >
            {tested ? 'Reset check' : 'Test interaction'}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {tested ? 'Interaction works.' : 'Ready when you are.'}
          </p>
        </div>
      </section>
    </div>
  );
}
