import type { DataTableColumn } from '@pertexo/node-sdk';
import {
  BracesIcon,
  CalendarIcon,
  HashIcon,
  ToggleRightIcon,
  TypeIcon,
  type LucideIcon,
} from 'lucide-react';

type ColumnType = DataTableColumn['type'];

/**
 * Each column type's mark and thread colour, used everywhere a table shows
 * its shape: the swatch on its card, its column chips and grid headers.
 */
export const COLUMN_TYPES: Readonly<
  Record<
    ColumnType,
    Readonly<{ icon: LucideIcon; text: string; thread: string }>
  >
> = {
  text: {
    icon: TypeIcon,
    text: 'text-foreground/70',
    thread: 'stroke-foreground/45',
  },
  number: { icon: HashIcon, text: 'text-action', thread: 'stroke-action' },
  boolean: {
    icon: ToggleRightIcon,
    text: 'text-success',
    thread: 'stroke-success',
  },
  date: {
    icon: CalendarIcon,
    text: 'text-secondary',
    thread: 'stroke-secondary',
  },
  json: { icon: BracesIcon, text: 'text-warning', thread: 'stroke-warning' },
};
