import type { CodeLanguage } from '@pertexo/node-sdk';

export const CODE_LANGUAGE_PRESENTATION = {
  javascript: {
    label: 'JavaScript',
    hint: 'Return JSON from input and $vars. Await is supported.',
    memorySuffix: ' heap',
  },
  python: {
    label: 'Python',
    hint: 'Return JSON from input and _vars. Use a synchronous function body; imports are limited to allowed modules.',
    memorySuffix: '',
  },
} as const satisfies Readonly<
  Record<
    CodeLanguage,
    Readonly<{ label: string; hint: string; memorySuffix: string }>
  >
>;

export const CODE_LANGUAGE_CHOICES = Object.entries(
  CODE_LANGUAGE_PRESENTATION,
).map(([value, { label }]) => ({ value, label }));
