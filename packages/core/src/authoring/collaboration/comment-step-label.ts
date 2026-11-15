/** A former step's label as a thread keeps it, in UTF-16 units. */
const STEP_LABEL_MAX_UNITS = 256;
const ELLIPSIS = '…';

/** Former-step metadata stays bounded without splitting a displayed grapheme. */
export function stepSnapshotLabel(value: string): string {
  if (value.length <= STEP_LABEL_MAX_UNITS) return value;
  let label = '';
  for (const { segment } of new Intl.Segmenter('und', {
    granularity: 'grapheme',
  }).segment(value)) {
    if (label.length + segment.length > STEP_LABEL_MAX_UNITS - ELLIPSIS.length)
      break;
    label += segment;
  }
  return label + ELLIPSIS;
}
