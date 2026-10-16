import { formLinkUrlSchema } from '@pertexo/workflow-model';

export function formMessageParts(message: string) {
  const parts: { offset: number; text: string; href?: string }[] = [];
  let end = 0;
  for (const match of message.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    const start = match.index;
    let text = match[0].replace(/[.,!?:;]+$/u, '');
    for (const [opening, closing] of [
      ['(', ')'],
      ['[', ']'],
    ] as const) {
      while (
        text.endsWith(closing) &&
        text.split(closing).length > text.split(opening).length
      )
        text = text.slice(0, -1);
    }
    const link = formLinkUrlSchema.safeParse(text);
    if (!link.success) continue;
    if (start > end)
      parts.push({ offset: end, text: message.slice(end, start) });
    parts.push({ offset: start, text, href: link.data });
    end = start + text.length;
  }
  if (end < message.length)
    parts.push({ offset: end, text: message.slice(end) });
  return parts;
}
