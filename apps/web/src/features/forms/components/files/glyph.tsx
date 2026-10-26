import type { FormFileGroup } from '@pertexo/workflow-model';
import {
  BracesIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  SheetIcon,
  type LucideProps,
} from 'lucide-react';

// Spreadsheets get a grid, like the Excel format tile: at this size Lucide's
// file-spreadsheet reads as the same lined page as documents.
const GLYPHS = {
  documents: FileTextIcon,
  images: ImageIcon,
  spreadsheets: SheetIcon,
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
