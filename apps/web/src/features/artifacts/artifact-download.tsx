import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, FileTextIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { describeReadError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { formatClock } from '@/lib/format-time';
import { getArtifactMetadata, prepareArtifactDownload } from './artifacts.api';
import { artifactMetadataQueryOptions } from './artifacts.queries';
import {
  describeFileKind,
  formatByteLength,
  shortArtifactId,
} from './model/artifact-labels';

type PreparedDownload = Awaited<ReturnType<typeof prepareArtifactDownload>>;

type ArtifactDownloadProps = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  artifactId: string;
  /** With the person's ID the card shows the file's type and size up front. */
  userId?: string;
}>;

/**
 * A file output as a card: its kind and size, and one Download button that
 * checks the file is ready, prepares a short-lived signed link and opens it.
 * If the browser blocks the new tab, the link stays on the card.
 */
export function ArtifactDownload(props: ArtifactDownloadProps) {
  return (
    <ArtifactDownloadScope
      key={`${props.userId ?? ''}:${props.workspaceId}:${props.artifactId}`}
      {...props}
    />
  );
}

function ArtifactDownloadScope({
  apiClient,
  workspaceId,
  artifactId,
  userId,
}: ArtifactDownloadProps) {
  const metadata = useQuery({
    ...artifactMetadataQueryOptions(
      apiClient,
      userId ?? '',
      workspaceId,
      artifactId,
    ),
    enabled: userId !== undefined,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [download, setDownload] = useState<PreparedDownload>();
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
      const known =
        metadata.data?.status === 'available'
          ? metadata.data
          : await getArtifactMetadata(
              apiClient,
              workspaceId,
              artifactId,
              controller.signal,
            );
      if (known.status !== 'available') {
        setError('This file is still being written. Try again in a moment.');
        return;
      }
      const prepared = await prepareArtifactDownload(
        apiClient,
        workspaceId,
        artifactId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDownload(prepared);
      // Opening straight away keeps it to one click; if the browser blocks
      // the tab, the link below still works.
      const opened = window.open(prepared.url, '_blank');
      if (opened) opened.opener = null;
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(describeReadError(cause, 'The file'));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const details = metadata.data;
  return (
    <div className="rounded-lg border border-white/8 bg-card px-3 py-2.5 text-sm">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-white/8 bg-white/[0.03] text-muted-foreground">
          <FileTextIcon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {describeFileKind(details?.mediaType)}
          </p>
          <p className="truncate font-mono text-[0.7rem] text-subtle-foreground">
            {details === undefined
              ? shortArtifactId(artifactId)
              : `${details.mediaType} · ${formatByteLength(details.byteLength)}`}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void prepare()}
        >
          {pending ? <LoadingOrb /> : <DownloadIcon aria-hidden="true" />}
          {pending ? 'Preparing…' : 'Download'}
        </Button>
      </div>
      {download === undefined ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          <a
            className="font-medium text-accent-foreground underline underline-offset-4"
            href={download.url}
            target="_blank"
            rel="noreferrer"
          >
            Open download link
          </a>{' '}
          · expires at {formatClock(download.expiresAt)}
        </p>
      )}
      {error === undefined ? null : (
        <Notice tone="destructive" className="mt-2">
          {error}
        </Notice>
      )}
    </div>
  );
}
