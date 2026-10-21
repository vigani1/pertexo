import { filePageBundleSchema } from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import { Disclosure } from '@/components/ui/disclosure';
import type { ApiClient } from '@/lib/api/client';
import { formatByteLength } from '@/lib/format/bytes';
import { ArtifactDownload } from './artifact-download';

/** Metadata only; each ordinary download still checks current file access. */
export function FilePages({
  value,
  apiClient,
  workspaceId,
}: Readonly<{ value: unknown; apiClient: ApiClient; workspaceId: string }>) {
  if (!isRecord(value)) return null;
  const parsed = filePageBundleSchema.safeParse({
    pages: value.pages,
    itemCount: value.itemCount,
    pageCount: value.pageCount,
  });
  if (!parsed.success) return null;
  const bundle = parsed.data;
  const bytes = bundle.pages.reduce(
    (total, page) => total + page.byteLength,
    0,
  );
  return (
    <section aria-label="Data pages" className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {bundle.itemCount.toLocaleString()}{' '}
        {bundle.itemCount === 1 ? 'record' : 'records'} · {bundle.pageCount}{' '}
        {bundle.pageCount === 1 ? 'page' : 'pages'} · {formatByteLength(bytes)}
      </p>
      {bundle.pageCount === 0 ? null : (
        <Disclosure
          summary="Download data pages"
          contentClassName="flex flex-col gap-3"
        >
          {bundle.pages.map((page, index) => (
            <div key={`${String(index)}:${page.artifactId}`}>
              <p className="mb-1 text-xs text-muted-foreground">
                Page {index + 1} · {formatByteLength(page.byteLength)}
              </p>
              <ArtifactDownload
                apiClient={apiClient}
                workspaceId={workspaceId}
                artifactId={page.artifactId}
              />
            </div>
          ))}
        </Disclosure>
      )}
    </section>
  );
}
