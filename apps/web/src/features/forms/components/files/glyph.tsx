import type { FormFileGroup } from '@pertexo/workflow-model';
import {
  BracesIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ImageIcon,
  type LucideProps,
} from 'lucide-react';

const GLYPHS = {
  documents: FileTextIcon,
  images: ImageIcon,
  spreadsheets: FileSpreadsheetIcon,
  data: BracesIcon,
} as const satisfies Record<FormFileGroup, typeof FileIcon>;

/** One glyph per kind of file, the same in setup and on each file row. */
export function FileGroupGlyph({
  group,
  ...props
}: LucideProps & Readonly<{ group: FormFileGroup | undefined }>) {
  const Glyph = group === undefined ? FileIcon : GLYPHS[group];
  return <Glyph aria-hidden="true" {...props} />;
}
