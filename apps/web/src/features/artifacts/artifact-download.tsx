import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { getArtifactMetadata, prepareArtifactDownload } from './artifacts.api';

const artifactExpiryFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'short',
});

export function ArtifactDownload({
  apiClient,
  workspaceId,
  artifactId,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  artifactId: string;
}>) {
  return (
    <ArtifactDownloadScope
      key={`${workspaceId}:${artifactId}`}
      apiClient={apiClient}
      workspaceId={workspaceId}
      artifactId={artifactId}
    />
  );
}

function ArtifactDownloadScope({
  apiClient,
  workspaceId,
  artifactId,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  artifactId: string;
}>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [download, setDownload] =
    useState<Awaited<ReturnType<typeof prepareArtifactDownload>>>();
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  async function prepare() {
    if (pending) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    setDownload(undefined);
    try {
      const metadata = await getArtifactMetadata(
        apiClient,
        workspaceId,
        artifactId,
        controller.signal,
      );
      if (metadata.status !== 'available')
        throw new Error('This artifact is not available yet.');
      setDownload(
        await prepareArtifactDownload(
          apiClient,
          workspaceId,
          artifactId,
          controller.signal,
        ),
      );
    } catch {
      if (!controller.signal.aborted)
        setError('The artifact download could not be prepared.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <div className="rounded-lg border p-3 text-sm">
      <p className="font-medium">Artifact output</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
        {artifactId}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void prepare()}
        >
          {pending ? 'Preparing…' : 'Prepare download'}
        </Button>
        {download ? (
          <a
            className={cn(buttonVariants({ size: 'sm' }))}
            href={download.url}
            target="_blank"
            rel="noreferrer"
          >
            Download artifact
          </a>
        ) : null}
      </div>
      {download ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Link expires{' '}
          {artifactExpiryFormatter.format(new Date(download.expiresAt))}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
