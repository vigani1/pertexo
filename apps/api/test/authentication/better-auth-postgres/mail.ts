import { captureLocalAuthenticationMail } from '../../support/better-auth/mail-capture.js';

export const { mail, mailedMessages } = captureLocalAuthenticationMail();
