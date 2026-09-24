import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts/schemas/schedules';
import type { WebhookTriggerHealthResponse } from '@pertexo/contracts/schemas/webhooks';
import type { StatusTone } from '@/components/ui/status';

type TriggerState = Readonly<{ tone: StatusTone; label: string }>;
type TriggerHealth = Pick<
  ScheduleTriggerHealthResponse | WebhookTriggerHealthResponse,
  'status' | 'healthStatus'
>;

const HEALTH: Readonly<
  Record<WebhookTriggerHealthResponse['healthStatus'], TriggerState>
> = {
  pending: { tone: 'neutral', label: 'Ready' },
  healthy: { tone: 'success', label: 'Healthy' },
  degraded: { tone: 'attention', label: 'Degraded' },
  unhealthy: { tone: 'failure', label: 'Unhealthy' },
  disabled: { tone: 'canceled', label: 'Off' },
};

/** One word for a trigger's configuration status and delivery health. */
export function describeTriggerState(trigger: TriggerHealth): TriggerState {
  switch (trigger.status) {
    case 'active':
      return HEALTH[trigger.healthStatus];
    case 'desired':
    case 'pending':
      return { tone: 'queued', label: 'Starting' };
    case 'configuration_required':
      return { tone: 'attention', label: 'Needs setup' };
    case 'degraded':
      return { tone: 'attention', label: 'Degraded' };
    case 'disabled':
      return { tone: 'canceled', label: 'Off' };
    case 'error':
      return { tone: 'failure', label: 'Error' };
  }
}
