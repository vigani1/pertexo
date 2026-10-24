import { Disclosure } from '@/components/ui/disclosure';

/** "Where do I find this?" — the provider's own steps, one click away. */
export function CredentialHelp({
  steps,
}: Readonly<{ steps: readonly string[] }>) {
  return (
    <Disclosure summary="Where do I find this?" appearance={{ tone: 'link' }}>
      <ol className="flex list-decimal flex-col gap-1.5 pl-9 text-muted-foreground marker:font-mono marker:text-xs marker:text-subtle-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Disclosure>
  );
}
