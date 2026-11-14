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
