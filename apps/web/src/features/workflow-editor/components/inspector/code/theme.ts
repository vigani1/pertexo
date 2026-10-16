import { tags } from '@lezer/highlight';

export const codeTheme = {
  '&': { color: 'var(--foreground)', fontSize: '0.8125rem' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    maxHeight: '24rem',
    overflow: 'auto',
  },
  '.cm-content': {
    minHeight: '14rem',
    padding: '0.75rem 0',
    caretColor: 'var(--foreground)',
  },
  '.cm-line': { padding: '0 0.75rem' },
  '.cm-gutters': {
    backgroundColor: 'var(--muted)',
    color: 'var(--subtle-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5rem' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--accent)',
    outline: '1px solid var(--border)',
  },
};

export const codeSyntaxStyles = [
  { tag: tags.keyword, color: 'var(--primary)', fontWeight: '600' },
  { tag: [tags.string, tags.regexp], color: 'var(--accent-foreground)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--primary)' },
  {
    tag: tags.comment,
    color: 'var(--subtle-foreground)',
    fontStyle: 'italic',
  },
  { tag: tags.function(tags.variableName), fontWeight: '600' },
];
