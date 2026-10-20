import { memo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { safeNoteUrl } from '../../../model/notes/markup';

const allowed = [
  'p',
  'br',
  'strong',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
  'hr',
];
const components = {
  a: ({
    href,
    children,
  }: Readonly<{ href?: string | undefined; children?: ReactNode }>) =>
    href === undefined ? (
      <span>{children}</span>
    ) : (
      <a
        className="inline-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
};
/** Memoized text avoids reparsing unchanged documentation during canvas gestures. */
export const NoteMarkdown = memo(function NoteMarkdown({
  text,
}: Readonly<{ text: string }>) {
  return (
    <div className="text-sm leading-relaxed break-words [&_p]:my-1.5 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:font-mono [&_code]:text-xs [&_hr]:my-3">
      <Markdown
        allowedElements={allowed}
        unwrapDisallowed
        skipHtml
        urlTransform={safeNoteUrl}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
