import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The app's own type scale (globals.css `--text-*`): without it, merging
// would read `text-label` as a colour and drop it beside a real colour.
const TYPE_SCALE = [
  'micro',
  'caption',
  'label',
  'lead',
  'wordmark',
  'wordmark-lg',
  'display',
] as const;

const merge = extendTailwindMerge({
  extend: { theme: { text: [...TYPE_SCALE] } },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
