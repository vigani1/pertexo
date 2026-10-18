import type { AuditEvent } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { describeAuditEvent } from '@/features/governance/model/ledger';

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    actorId: '20000000-0000-4000-8000-000000000002',
    actorName: 'Vigan',
    action: 'workflow.published',
    targetType: 'workflow',
    targetId: '30000000-0000-4000-8000-000000000003',
    occurredAt: '2026-10-18T10:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('audit ledger sentences', () => {
  it('reads a known action with its particulars', () => {
    expect(
      describeAuditEvent(event({ metadata: { versionNumber: 3 } })),
    ).toEqual({
      actor: 'Vigan',
      words: 'published a workflow',
      particulars: ['v3'],
      tone: 'success',
      known: true,
    });
    expect(
      describeAuditEvent(
        event({
          action: 'workspace.member_role_changed',
          metadata: { fromRole: 'viewer', toRole: 'admin' },
        }),
      ).particulars,
    ).toEqual(['Viewer → Admin']);
    expect(
      describeAuditEvent(
        event({
          action: 'workspace.member_added',
          metadata: { role: 'builder', source: 'directory' },
        }),
      ).particulars,
    ).toEqual(['as Builder', 'from the directory']);
  });

  it('names who acted even without a person and reads unknown actions aloud', () => {
    const system = describeAuditEvent(
      event({
        actorId: null,
        actorName: null,
        action: 'schedule.admission_throttled',
      }),
    );
    expect(system.actor).toBe('Pertexo');
    expect(system.words).toBe('recorded “schedule admission throttled”');
    expect(system.known).toBe(false);
    expect(describeAuditEvent(event({ actorName: null })).actor).toBe(
      'A former member',
    );
  });
});
