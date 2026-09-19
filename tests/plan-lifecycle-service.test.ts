import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/index.js';
import { PlanLifecycleService } from '../src/lifecycle/plan-lifecycle.js';

describe('0.7.3 public plan lifecycle contract', () => {
  function service() {
    const events = new EventBus();
    const projects = { findById: (id: string) => id === 'p' ? ({ id } as never) : null };
    const agents = { getAgent: (id: string) => id === 'lead' ? ({ id } as never) : null };
    return { service: new PlanLifecycleService(projects as never, agents as never, events), events };
  }

  it('creates a versioned plan and binds approval to the exact version', () => {
    const { service: s } = service();
    const intake = s.createIntake({ projectId: 'p', createdBy: 'human-1', goal: 'Ship feature', leadAgentId: 'lead' });
    const plan = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'One step', tasks: [{ clientId: 'a', title: 'A' }], dependencies: [] });
    expect(plan.state).toBe('WAITING_APPROVAL'); expect(plan.currentVersion).toBe(1);
    expect(s.decide(plan.planId, 1, 'APPROVE', 'human-1', '').state).toBe('APPROVED');
    expect(() => s.decide(plan.planId, 0, 'APPROVE', 'human-1', '')).toThrow('PLAN_STALE');
  });

  it('rejects dependency cycles and keeps plan revision distinct from approval', () => {
    const { service: s } = service();
    const intake = s.createIntake({ projectId: 'p', createdBy: 'human-1', goal: 'Cycle', leadAgentId: 'lead' });
    expect(() => s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'bad', tasks: [{ clientId: 'a', title: 'A' }, { clientId: 'b', title: 'B' }], dependencies: [{ prerequisiteClientId: 'a', dependentClientId: 'b' }, { prerequisiteClientId: 'b', dependentClientId: 'a' }] })).toThrow('PLAN_CYCLE');
    const plan = s.createPlan({ intakeId: intake.intakeId, leadAgentId: 'lead', summary: 'ok', tasks: [{ clientId: 'a', title: 'A' }], dependencies: [] });
    expect(s.decide(plan.planId, 1, 'REQUEST_CHANGES', 'human-1', 'Clarify')).toMatchObject({ state: 'CHANGES_REQUESTED', currentVersion: 1 });
  });
});
