import { ApiConfigurationError } from './api-configuration.errors.js';

const remedies = {
  invalid_configuration:
    'supply matching settings and valid keys; check the identity configuration guide.',
  incomplete_pair: 'supply both settings or remove both.',
  required_secret:
    // session-setting-exempt: an operator-facing configuration message, not SQL
    'set BETTER_AUTH_SECRET to a private secret of at least 32 characters.',
  invitation_pair:
    'configure both invitation key settings together; keep them configured when deployed.',
  // session-setting-exempt: an operator-facing configuration message, not SQL
  required_origin: 'set PUBLIC_WEB_ORIGIN to the browser application origin.',
  https_origin: 'use an HTTPS public web origin when deployed.',
  secure_origin: 'use an HTTPS public web origin for secure session cookies.',
  secure_deployment: 'enable secure session cookies when deployed.',
  same_site_secure:
    'enable secure session cookies or select a different same-site policy.',
  origin_shape: 'use an origin without a path, query or fragment.',
  durable_mail: 'configure durable authentication mail when deployed.',
} as const;

/** Contains only owned setting names and remedies, never rejected input. */
export class IdentityConfigurationError extends ApiConfigurationError {
  public override readonly name = 'IdentityConfigurationError';
  public constructor(settings: string, rule: keyof typeof remedies) {
    super(settings, remedies[rule], rule);
  }
}
