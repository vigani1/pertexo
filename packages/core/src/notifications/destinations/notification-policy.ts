export const notificationProviderRequirements = Object.freeze({
  email: Object.freeze({
    authType: 'resend_api_key',
    providerKey: 'email',
    sideEffectClass: 'idempotent_with_key',
  }),
  slack: Object.freeze({
    authType: 'slack_bot_token',
    providerKey: 'slack',
    sideEffectClass: 'unsafe',
  }),
} as const);

type NotificationKind = keyof typeof notificationProviderRequirements;

export function eligibleNotificationDestination(
  destination:
    | Readonly<{
        connection_id: string | null;
        destination_status: string;
        kind: NotificationKind;
        side_effect_class: string;
      }>
    | undefined,
): destination is NonNullable<typeof destination> & { connection_id: string } {
  return (
    destination?.connection_id != null &&
    destination.destination_status === 'enabled' &&
    destination.side_effect_class ===
      notificationProviderRequirements[destination.kind].sideEffectClass
  );
}

export function eligibleNotificationConnection(
  kind: NotificationKind,
  connection:
    | Readonly<{
        auth_type: string;
        provider_key: string;
        status: string;
      }>
    | undefined,
): connection is NonNullable<typeof connection> {
  const requirements = notificationProviderRequirements[kind];
  return (
    connection?.status === 'active' &&
    connection.provider_key === requirements.providerKey &&
    connection.auth_type === requirements.authType
  );
}
