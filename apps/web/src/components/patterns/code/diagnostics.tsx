import type { PreviewRunSummary } from '@pertexo/contracts';
import { CopyButton } from '@/components/ui/copy-button';

type Diagnostics = NonNullable<PreviewRunSummary['codeDiagnostics']>;

/** Private attempt data: render user text literally, including error messages. */
export function CodeDiagnostics({
  diagnostics,
}: Readonly<{ diagnostics: Diagnostics }>) {
  const text = diagnostics.logs
    .map((entry) => `[${entry.level}] ${entry.message}`)
    .join('\n');
  return (
    <section
      aria-label="Code diagnostics"
      className="flex min-w-0 flex-col gap-2"
    >
      {diagnostics.error === undefined ? null : (
        <div className="rounded-md border border-destructive/30 p-3 text-xs">
          <p className="whitespace-pre-wrap break-words text-destructive">
            {diagnostics.error.message}
          </p>
          {diagnostics.error.line === undefined ? null : (
            <p className="mt-1 font-mono text-muted-foreground">
              Line {diagnostics.error.line}
              {diagnostics.error.column === undefined
                ? ''
                : `, column ${String(diagnostics.error.column)}`}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-subtle-foreground">
          Console
        </h3>
        {text === '' ? null : (
          <CopyButton value={text} label="Copy console output" />
        )}
      </div>
      {text === '' ? (
        <p className="text-xs text-muted-foreground">No console output.</p>
      ) : (
        <pre
          aria-label="Code console output"
          className="max-h-56 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
        >
          {text}
        </pre>
      )}
      {diagnostics.truncated ? (
        <p className="text-xs text-muted-foreground">
          Console output was truncated at its size or message limit.
        </p>
      ) : null}
    </section>
  );
}
