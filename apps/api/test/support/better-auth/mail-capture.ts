import { LocalAuthenticationMailSink } from '../../../src/authentication/index.js';
import type { LocalAuthenticationMailMessage } from '../../../src/authentication/mail/delivery.js';

/** Captures the local sink's observable messages in the fixture, not the API. */
export function captureLocalAuthenticationMail() {
  const received: LocalAuthenticationMailMessage[] = [];
  return {
    mail: new LocalAuthenticationMailSink((message) => received.push(message)),
    mailedMessages: (
      recipient?: string,
    ): readonly LocalAuthenticationMailMessage[] =>
      received.filter(
        (message) => recipient === undefined || message.recipient === recipient,
      ),
  };
}
