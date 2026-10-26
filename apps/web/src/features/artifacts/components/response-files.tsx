import { formFileValueSchema, isRecord } from '@pertexo/workflow-model';
import type { ApiClient } from '@/lib/api/client';
import { ArtifactDownload } from './artifact-download';

type ResponseFile = Readonly<{ artifactId: string; filename: string }>;

/** Files a form or input request responder attached, wherever they sit in a value. */
function responseFiles(value: unknown): readonly ResponseFile[] {
  const found: ResponseFile[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0 && found.length < 100) {
    const current = pending.shift();
    const file = formFileValueSchema.safeParse(current);
    if (file.success)
      found.push({
        artifactId: file.data.file.artifactId,
        filename: file.data.filename,
      });
    else if (Array.isArray(current)) pending.push(...(current as unknown[]));
    else if (isRecord(current)) pending.push(...Object.values(current));
  }
  return found;
}

/** Download cards for a response's files; each download checks current access. */
export function ResponseFiles({
  value,
  apiClient,
  userId,
  workspaceId,
}: Readonly<{
  value: unknown;
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>) {
  const files = responseFiles(value);
  if (files.length === 0) return null;
  return (
    <section aria-label="Uploaded files" className="flex flex-col gap-2">
      {files.map((file) => (
        <ArtifactDownload
          key={file.artifactId}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspaceId}
          artifactId={file.artifactId}
          filename={file.filename}
        />
      ))}
    </section>
  );
}
