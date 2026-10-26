import {
  assertFormFileSize,
  FORM_FILE_GROUPS,
  FormFileRejectedError,
  formatFormFileBytes,
  formFileExtension,
  formFileType,
  type FormField,
  type FormFileGroup,
} from '@pertexo/workflow-model';

export type FileField = Extract<FormField, { type: 'file' }>;

export const FILE_GROUPS: readonly Readonly<{
  group: FormFileGroup;
  label: string;
  /** How the responder's drop zone names it. */
  short: string;
}>[] = [
  { group: 'documents', label: 'Documents', short: 'PDF, Word, text' },
  { group: 'images', label: 'Images', short: 'images' },
  { group: 'spreadsheets', label: 'Spreadsheets', short: 'Excel, CSV' },
  { group: 'data', label: 'Data', short: 'JSON, XML' },
];

/** "PDF, Word, text, images · up to 5 MB each · 3 files" */
export function acceptSummary(field: FileField): string {
  const kinds = FILE_GROUPS.filter(({ group }) =>
    field.accept.includes(group),
  ).map(({ short }) => short);
  const size = `up to ${formatFormFileBytes(field.maxBytes)}${field.maxFiles === 1 ? '' : ' each'}`;
  const count =
    field.maxFiles === 1 ? '' : ` · ${String(field.maxFiles)} files`;
  return `${kinds.join(', ')} · ${size}${count}`;
}

/** The picker's filter; images also offer the camera on phones. */
export function acceptAttribute(field: FileField): string {
  const extensions = field.accept.flatMap((group) =>
    FORM_FILE_GROUPS[group].map((extension) => `.${extension}`),
  );
  return [
    ...extensions,
    ...(field.accept.includes('images') ? ['image/*'] : []),
  ].join(',');
}

export function fileGroupOf(filename: string): FormFileGroup | undefined {
  const extension = formFileExtension(filename);
  return FILE_GROUPS.find(({ group }) =>
    (FORM_FILE_GROUPS[group] as readonly string[]).includes(extension ?? ''),
  )?.group;
}

/** The server's own words for a file it would refuse, checked before upload. */
export function chosenFileProblem(
  field: FileField,
  file: Readonly<{ name: string; size: number }>,
): string | undefined {
  try {
    formFileType(file.name, field.accept);
    assertFormFileSize(file.size, field.maxBytes);
    return undefined;
  } catch (error) {
    if (error instanceof FormFileRejectedError) return error.message;
    throw error;
  }
}
