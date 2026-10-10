import { ChevronRightIcon } from 'lucide-react';

/** "Where do I find this?" — the provider's own steps, one click away. */
export function CredentialHelp({
  steps,
}: Readonly<{ steps: readonly string[] }>) {
  return (
    <details className="group/help text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-accent-foreground outline-none select-none focus-visible:underline [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-open/help:rotate-90"
        />
        Where do I find this?
      </summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-9 text-muted-foreground marker:font-mono marker:text-xs marker:text-subtle-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </details>
  );
}
