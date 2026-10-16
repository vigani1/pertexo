import { Fragment } from 'react';
import { formMessageParts } from '../model/message-links';

export function ThankYouMessage({ message }: Readonly<{ message: string }>) {
  return formMessageParts(message).map((part) =>
    part.href === undefined ? (
      <Fragment key={part.offset}>{part.text}</Fragment>
    ) : (
      <a
        key={part.offset}
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="underline underline-offset-4"
      >
        {part.text}
      </a>
    ),
  );
}
