import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { StatusGlyph } from '@/components/ui/status';
import { ArtifactDownload } from '@/features/artifacts/public';
import type { ApiClient } from '@/lib/api/client';
import type { ThreadRow } from '../../model/thread-view';

/**
 * What went in and what came out. File outputs download from here; inline
 * results and the run's input need API reads that don't exist yet, and the
 * page says so instead of guessing.
 */
export function RunOutputsView({
  rows,
  apiClient,
  userId,
  workspace,
}: Readonly<{
  rows: readonly ThreadRow[];
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const canReadArtifacts = workspace.capabilities.includes('artifact:read');
  const withFiles = rows.filter((row) =>
    row.outputs.some((output) => output.kind === 'artifact'),
  );
  const withInline = rows.filter((row) =>
    row.outputs.some((output) => output.kind === 'inline'),
  );
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section>
        <h2 className="text-lg font-semibold">Input</h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          Pertexo keeps the input this run started with for replays, but the API
          doesn’t return it to the app yet. When you replay, you enter the input
          again.
        </p>
      </section>
      <section>
        <h2 className="text-lg font-semibold">Output</h2>
        {withFiles.length === 0 && withInline.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No step has reported an output yet.
          </p>
        ) : null}
        <div className="mt-3 flex flex-col gap-4">
          {withFiles.map((row) => (
            <div key={row.key} className="flex flex-col gap-2">
              <h3 className="font-sans text-xs font-semibold text-subtle-foreground">
                {row.label}
              </h3>
              {canReadArtifacts ? (
                row.outputs.map((output) =>
                  output.kind === 'artifact' ? (
                    <ArtifactDownload
                      key={output.artifactId}
                      apiClient={apiClient}
                      userId={userId}
                      workspaceId={workspace.id}
                      artifactId={output.artifactId}
                    />
                  ) : null,
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  This step produced a file, but your role can’t download files.
                </p>
              )}
            </div>
          ))}
          {withInline.length > 0 ? (
            <div className="flex gap-2.5 rounded-md border border-white/8 p-3 text-sm text-muted-foreground">
              <StatusGlyph tone="neutral" className="mt-0.5" />
              <p>
                {withInline.map((row) => row.label).join(', ')}{' '}
                {withInline.length === 1
                  ? 'returned a result'
                  : 'returned results'}{' '}
                that Pertexo keeps with each attempt. Showing them here needs an
                API endpoint that isn’t available yet.
              </p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
