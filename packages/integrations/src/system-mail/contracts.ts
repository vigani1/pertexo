export type SystemMailConfig =
  | Readonly<{ mode: 'resend'; apiKey: string }>
  | Readonly<{
      mode: 'smtp';
      host: string;
      port: number;
      tls: 'starttls' | 'implicit' | 'none';
      auth?: Readonly<{ user: string; pass: string }>;
    }>;

export type SystemMailMessage = Readonly<{
  fromEmail: string;
  toEmail: string;
  subject: string;
  text: string;
  unsubscribeUrl?: string;
  idempotencyKey: string;
  timeoutMillis: number;
  signal?: AbortSignal;
  beforeDispatch(): Promise<void>;
}>;

export type SystemMailResult =
  | Readonly<{ kind: 'submitted'; reference: string }>
  | Readonly<{ kind: 'retryable' | 'failed' | 'unknown' }>;

export type SystemMailClient = Readonly<{
  deduplicates: boolean;
  sendNotification(message: SystemMailMessage): Promise<SystemMailResult>;
}>;
