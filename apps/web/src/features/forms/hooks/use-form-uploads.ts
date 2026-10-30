import { useEffect, useRef, useState } from 'react';
import type { FormField } from '@pertexo/workflow-model';
import { isApiError } from '@/lib/api/error';
import { digestFile, transferFile } from '@/features/artifacts/public';
import type { FormUploadTarget } from '../data/uploads.api';
import { chosenFileProblem, type FileField } from '../model/files';
import {
  uploadFailure,
  type UploadRow,
  type UploadState,
} from '../model/uploads';

interface Entry {
  readonly field: FileField;
  readonly file: File;
  readonly key: string;
  readonly idempotencyKey: string;
  sha256?: string;
  uploadId?: string;
  controller?: AbortController;
}
type Rows = Readonly<Record<string, readonly UploadRow[]>>;

class UploadsUnavailableError extends Error {}

/**
 * Every file field's uploads for one response. Files and signed capabilities
 * stay in memory; only finished upload IDs reach the submitted values.
 */
export function useFormUploads(target: FormUploadTarget | undefined) {
  const [rows, setRows] = useState<Rows>({});
  // The rows as of the last change, not the last render: two drops before a
  // render must both count the files already taken.
  const latest = useRef<Rows>(rows);
  const entries = useRef(new Map<string, Entry>());

  function change(next: (previous: Rows) => Rows) {
    latest.current = next(latest.current);
    setRows(latest.current);
  }

  useEffect(() => {
    const live = entries.current;
    return () => {
      for (const entry of live.values()) entry.controller?.abort();
    };
  }, []);

  function update(entry: Entry, state: UploadState) {
    change((previous) => ({
      ...previous,
      [entry.field.name]: (previous[entry.field.name] ?? []).map((row) =>
        row.key === entry.key
          ? { key: row.key, name: row.name, size: row.size, ...state }
          : row,
      ),
    }));
  }

  async function send(entry: Entry) {
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    const show = (state: UploadState) => {
      if (!controller.signal.aborted) update(entry, state);
    };
    try {
      if (target === undefined) throw new UploadsUnavailableError();
      show({
        phase: 'ready',
        uploadId: await upload(target, entry, controller.signal, show),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure =
        error instanceof UploadsUnavailableError
          ? { message: 'Files can’t be attached here.', retryable: false }
          : uploadFailure(error);
      show({
        phase: 'failed',
        error: failure.message,
        retryable: failure.retryable,
      });
    }
  }

  /** Adds what fits; returns how many files were left out. */
  function add(field: FileField, files: readonly File[]): number {
    const current = latest.current[field.name] ?? [];
    const taken = current.filter((row) => row.phase !== 'failed').length;
    const fitting = files.slice(0, Math.max(0, field.maxFiles - taken));
    const added = fitting.map((file) => {
      const entry: Entry = {
        field,
        file,
        key: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      };
      const problem = chosenFileProblem(field, file);
      if (problem === undefined) entries.current.set(entry.key, entry);
      const row: UploadRow =
        problem === undefined
          ? {
              key: entry.key,
              name: file.name,
              size: file.size,
              phase: 'checking',
            }
          : {
              key: entry.key,
              name: file.name,
              size: file.size,
              phase: 'failed',
              error: problem,
              retryable: false,
            };
      return { entry, row, problem };
    });
    change((previous) => ({
      ...previous,
      [field.name]: [
        ...(previous[field.name] ?? []),
        ...added.map(({ row }) => row),
      ],
    }));
    for (const { entry, problem } of added)
      if (problem === undefined) void send(entry);
    return files.length - fitting.length;
  }

  function remove(field: FormField, key: string) {
    entries.current.get(key)?.controller?.abort();
    entries.current.delete(key);
    change((previous) => ({
      ...previous,
      [field.name]: (previous[field.name] ?? []).filter(
        (row) => row.key !== key,
      ),
    }));
  }

  function retry(key: string) {
    const entry = entries.current.get(key);
    if (entry !== undefined) void send(entry);
  }

  return {
    rows,
    add,
    remove,
    retry,
    /** Files still on their way; a response waits for them. */
    pending: Object.values(rows).some((list) =>
      list.some((row) => row.phase !== 'ready' && row.phase !== 'failed'),
    ),
    uploadIds: (field: FormField): readonly string[] =>
      (rows[field.name] ?? []).flatMap((row) =>
        row.phase === 'ready' ? [row.uploadId] : [],
      ),
  };
}

/**
 * Finished earlier but the reply was lost: finalizing again is safe. Returns
 * the finished upload's ID.
 */
async function alreadyFinished(
  target: FormUploadTarget,
  entry: Entry,
  signal: AbortSignal,
): Promise<string | undefined> {
  const { uploadId } = entry;
  if (uploadId === undefined) return undefined;
  try {
    await target.finalize(uploadId, signal);
    return uploadId;
  } catch (error) {
    if (isApiError(error) && error.problem?.code === 'artifact.conflict')
      return undefined;
    throw error;
  }
}

/**
 * Check, reserve, send and verify one file, returning its upload ID; an exact
 * retry reuses its key.
 */
async function upload(
  target: FormUploadTarget,
  entry: Entry,
  signal: AbortSignal,
  show: (state: UploadState) => void,
): Promise<string> {
  show({ phase: 'checking' });
  entry.sha256 ??= await digestFile(entry.file, signal);
  const finished = await alreadyFinished(target, entry, signal);
  if (finished !== undefined) return finished;
  show({ phase: 'reserving' });
  const reservation = await target.begin(
    {
      fieldId: entry.field.id,
      filename: entry.file.name,
      byteLength: entry.file.size,
      sha256: entry.sha256,
    },
    entry.idempotencyKey,
    signal,
  );
  const uploadId = reservation.upload.id;
  entry.uploadId = uploadId;
  show({ phase: 'sending' });
  await transferFile(entry.file, reservation.transfer, signal);
  show({ phase: 'verifying' });
  await target.finalize(uploadId, signal);
  return uploadId;
}
