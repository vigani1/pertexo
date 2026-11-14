export class SystemMailConfigurationError extends Error {
  public override readonly name = 'SystemMailConfigurationError';
  public constructor(
    public readonly setting: string,
    public readonly reason:
      | 'api_key_required'
      | 'mail_transport_required'
      | 'smtp_hostname_required'
      | 'smtp_port_required'
      | 'smtp_tls_required'
      | 'smtp_credentials_required',
  ) {
    super('System mail configuration is invalid');
  }
}

/** A queued mail's sealed payload can't be opened with the configured keys. */
export class SystemMailPayloadUnavailableError extends Error {
  public override readonly name = 'SystemMailPayloadUnavailableError';
}

/** The mail's recipient may no longer receive it; the claim is superseded. */
export class SystemMailNoLongerEligibleError extends Error {
  public override readonly name = 'SystemMailNoLongerEligibleError';
}

/** The SMTP host couldn't be resolved to a permitted address in time. */
export class SmtpLookupError extends Error {
  public override readonly name = 'SmtpLookupError';
}
