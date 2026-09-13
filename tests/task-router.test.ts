import { describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentStatus,
  TaskComplexity,
  TaskRisk,
  TaskRouter,
  type Agent,
  type ProviderRoutingCapabilities,
  type Task,
  type TaskRoutePlan,
  type TaskRoutingRequest,
} from '../src/index.js';

const router = new TaskRouter();

describe('TaskRouter static eligibility', () => {
  it('returns deterministic empty and no-eligible plans', () => {
    const empty = route({ agents: [], providerCapabilities: [] });
    expect(empty).toMatchObject({ version: 1, taskId: 'TASK-A', projectId: 'PROJECT-A', candidates: [], rejected: [] });
    expect(empty.routePlanSha256).toMatch(/^[a-f0-9]{64}$/u);

    const none = route({ agents: [agent({ enabled: false })], providerCapabilities: [provider()] });
    expect(none.candidates).toEqual([]);
    expect(none.rejected).toEqual([{ agentId: 'AGENT-A', providerId: 'provider-a', reasons: ['AGENT_DISABLED'] }]);
  });

  it('allows same-project and global agents but rejects another project', () => {
    const plan = route({
      agents: [
        agent({ id: 'same', projectId: 'PROJECT-A' }),
        agent({ id: 'global', projectId: null }),
        agent({ id: 'wrong', projectId: 'PROJECT-B' }),
      ],
      providerCapabilities: [provider()],
    });
    expect(plan.candidates.map(({ agentId, scope }) => [agentId, scope])).toEqual([
      ['same', 'project'], ['global', 'global'],
    ]);
    expect(plan.rejected).toEqual([{ agentId: 'wrong', providerId: 'provider-a', reasons: ['PROJECT_MISMATCH'] }]);
  });

  it('treats BUSY and OFFLINE as statically suitable while disabled states are ineligible', () => {
    const plan = route({
      agents: [
        agent({ id: 'busy', status: AgentStatus.BUSY }),
        agent({ id: 'offline', status: AgentStatus.OFFLINE }),
        agent({ id: 'disabled-status', status: AgentStatus.DISABLED }),
        agent({ id: 'disabled-flag', enabled: false }),
      ],
      providerCapabilities: [provider()],
    });
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['busy', 'offline']);
    expect(plan.rejected).toEqual([
      { agentId: 'disabled-flag', providerId: 'provider-a', reasons: ['AGENT_DISABLED'] },
      { agentId: 'disabled-status', providerId: 'provider-a', reasons: ['AGENT_DISABLED'] },
    ]);
  });

  it('requires exact complexity, risk, capability, and specialty matches', () => {
    const plan = route({
      task: task({ requiredCapabilities: ['CODING'], requiredSpecialties: ['typescript'] }),
      agents: [
        agent({ id: 'eligible', capabilities: ['CODING', 'EXTRA'], specialties: ['typescript', 'other'] }),
        agent({ id: 'complexity', allowedComplexities: [TaskComplexity.COMPLEX] }),
        agent({ id: 'risk', allowedRiskLevels: [TaskRisk.HIGH] }),
        agent({ id: 'cap-case', capabilities: ['coding'], specialties: ['typescript'] }),
        agent({ id: 'specialty-case', capabilities: ['CODING'], specialties: ['TypeScript'] }),
      ],
      providerCapabilities: [provider()],
    });
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['eligible']);
    expect(reasonFor(plan, 'complexity')).toEqual(['COMPLEXITY_UNSUPPORTED', 'MISSING_CAPABILITY', 'MISSING_SPECIALTY']);
    expect(reasonFor(plan, 'risk')).toEqual(['RISK_UNSUPPORTED', 'MISSING_CAPABILITY', 'MISSING_SPECIALTY']);
    expect(reasonFor(plan, 'cap-case')).toEqual(['MISSING_CAPABILITY']);
    expect(reasonFor(plan, 'specialty-case')).toEqual(['MISSING_SPECIALTY']);
  });

  it('enforces the explicit authority ordering without a default role requirement', () => {
    const unrestricted = route({ agents: [agent({ authority: AgentAuthority.READ_ONLY })], providerCapabilities: [provider()] });
    expect(unrestricted.candidates).toHaveLength(1);
    const required = route({
      agents: [
        agent({ id: 'lower', authority: AgentAuthority.READ_ONLY }),
        agent({ id: 'exact', authority: AgentAuthority.STANDARD }),
        agent({ id: 'higher', authority: AgentAuthority.ADMIN }),
      ],
      providerCapabilities: [provider()],
      requirements: { minimumAuthority: AgentAuthority.STANDARD },
    });
    expect(required.candidates.map(({ agentId }) => agentId)).toEqual(['exact', 'higher']);
    expect(reasonFor(required, 'lower')).toEqual(['AUTHORITY_INSUFFICIENT']);
  });

  it('requires provider descriptors and every explicitly requested output protocol', () => {
    const plan = route({
      agents: [
        agent({ id: 'supported', provider: 'both' }),
        agent({ id: 'protocol-missing', provider: 'worker' }),
        agent({ id: 'descriptor-missing', provider: 'absent' }),
      ],
      providerCapabilities: [
        provider('both', ['manager-directive', 'worker-result']),
        provider('worker', ['worker-result']),
      ],
      requirements: { requiredOutputProtocols: ['manager-directive'] },
    });
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['supported']);
    expect(reasonFor(plan, 'protocol-missing')).toEqual(['OUTPUT_PROTOCOL_UNSUPPORTED']);
    expect(reasonFor(plan, 'descriptor-missing')).toEqual(['PROVIDER_UNAVAILABLE', 'OUTPUT_PROTOCOL_UNSUPPORTED']);
  });

  it('collects every applicable rejection reason in fixed order', () => {
    const plan = route({
      task: task({ requiredCapabilities: ['needed'], requiredSpecialties: ['special'] }),
      agents: [agent({
        projectId: 'OTHER', enabled: false, status: AgentStatus.DISABLED,
        allowedComplexities: [], allowedRiskLevels: [], capabilities: [], specialties: [],
        authority: AgentAuthority.READ_ONLY, provider: 'missing',
      })],
      providerCapabilities: [],
      requirements: {
        minimumAuthority: AgentAuthority.ADMIN,
        requiredOutputProtocols: ['manager-directive'],
      },
    });
    expect(reasonFor(plan, 'AGENT-A')).toEqual([
      'AGENT_DISABLED',
      'PROJECT_MISMATCH',
      'COMPLEXITY_UNSUPPORTED',
      'RISK_UNSUPPORTED',
      'MISSING_CAPABILITY',
      'MISSING_SPECIALTY',
      'AUTHORITY_INSUFFICIENT',
      'PROVIDER_UNAVAILABLE',
      'OUTPUT_PROTOCOL_UNSUPPORTED',
    ]);
  });

  it('never lets high priority override hard eligibility', () => {
    const plan = route({
      task: task({ requiredSpecialties: ['required'] }),
      agents: [
        agent({ id: 'high-ineligible', routingPriority: 999 }),
        agent({ id: 'low-eligible', routingPriority: 10, specialties: ['required'] }),
      ],
      providerCapabilities: [provider()],
    });
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['low-eligible']);
    expect(reasonFor(plan, 'high-ineligible')).toEqual(['MISSING_SPECIALTY']);
  });
});

describe('TaskRouter deterministic ranking and identity', () => {
  it('ranks by priority DESC, project scope, then lexical agent ID only', () => {
    const agents = [
      agent({ id: 'z-project', projectId: 'PROJECT-A', routingPriority: 20, provider: 'codex', model: 'low', position: 'worker' }),
      agent({ id: 'a-global', projectId: null, routingPriority: 30, provider: 'claude', model: 'high', position: 'manager' }),
      agent({ id: 'b-global', projectId: null, routingPriority: 20, provider: 'claude' }),
      agent({ id: 'a-project', projectId: 'PROJECT-A', routingPriority: 20, provider: 'codex' }),
    ];
    const providers = [provider('codex'), provider('claude')];
    const first = route({ agents, providerCapabilities: providers });
    const reversed = route({ agents: [...agents].reverse(), providerCapabilities: [...providers].reverse() });
    expect(first.candidates.map(({ rank, agentId }) => [rank, agentId])).toEqual([
      [1, 'a-global'], [2, 'a-project'], [3, 'z-project'], [4, 'b-global'],
    ]);
    expect(reversed).toEqual(first);
  });

  it('canonicalizes IDLE, BUSY, and OFFLINE as the same static route identity', () => {
    const plans = [AgentStatus.IDLE, AgentStatus.BUSY, AgentStatus.OFFLINE]
      .map((status) => route({ agents: [agent({ status })], providerCapabilities: [provider()] }));
    for (const plan of plans) {
      expect(plan.candidates).toEqual([{
        rank: 1,
        agentId: 'AGENT-A',
        providerId: 'provider-a',
        routingPriority: 1,
        scope: 'project',
      }]);
      expect(plan.rejected).toEqual([]);
      expect(plan.routePlanSha256).toBe(plans[0]?.routePlanSha256);
    }
  });

  it('canonicalizes equivalent statically disabled representations', () => {
    const disabledAgents = [
      agent({ enabled: false, status: AgentStatus.IDLE }),
      agent({ enabled: false, status: AgentStatus.BUSY }),
      agent({ enabled: false, status: AgentStatus.DISABLED }),
      agent({ enabled: true, status: AgentStatus.DISABLED }),
    ];
    const plans = disabledAgents.map((disabledAgent) => route({
      agents: [disabledAgent],
      providerCapabilities: [provider()],
    }));
    for (const plan of plans) {
      expect(plan.candidates).toEqual([]);
      expect(plan.rejected).toEqual([{
        agentId: 'AGENT-A',
        providerId: 'provider-a',
        reasons: ['AGENT_DISABLED'],
      }]);
      expect(plan.routePlanSha256).toBe(plans[0]?.routePlanSha256);
    }
  });

  it('changes route identity across the static enabled boundary', () => {
    const enabled = route({ agents: [agent()], providerCapabilities: [provider()] });
    for (const disabled of [
      route({ agents: [agent({ enabled: false })], providerCapabilities: [provider()] }),
      route({ agents: [agent({ status: AgentStatus.DISABLED })], providerCapabilities: [provider()] }),
    ]) {
      expect(disabled.candidates).toEqual([]);
      expect(disabled.rejected[0]?.reasons).toEqual(['AGENT_DISABLED']);
      expect(disabled.routePlanSha256).not.toBe(enabled.routePlanSha256);
    }
  });

  it('rejects duplicate agent and provider identities instead of deduplicating', () => {
    expectRouterError(
      () => route({ agents: [agent(), agent()], providerCapabilities: [provider()] }),
      'TASK_ROUTER_DUPLICATE_AGENT',
    );
    expectRouterError(
      () => route({ agents: [], providerCapabilities: [provider(), provider()] }),
      'TASK_ROUTER_DUPLICATE_PROVIDER',
    );
  });
});

describe('TaskRouter snapshot, digest, validation, and immutability', () => {
  it('canonicalizes logical sets and excludes unrelated descriptive fields from the digest', () => {
    const base = request({
      task: task({ requiredCapabilities: ['B', 'A', 'A'], requiredSpecialties: ['two', 'one', 'one'] }),
      agents: [agent({ capabilities: ['B', 'A', 'A'], specialties: ['two', 'one', 'one'] })],
      providerCapabilities: [provider('provider-a', ['worker-result', 'manager-directive', 'worker-result'])],
      requirements: { requiredOutputProtocols: ['worker-result', 'worker-result'] },
    });
    const baseAgent = base.agents[0];
    if (baseAgent === undefined) throw new Error('missing fixture agent');
    const equivalent = request({
      task: { ...base.task, title: 'different', description: 'ignored', requiredCapabilities: ['A', 'B'], requiredSpecialties: ['one', 'two'] },
      agents: [{ ...baseAgent, name: 'different', model: 'different', position: 'different',
        capabilities: ['A', 'B'], specialties: ['one', 'two'] }],
      providerCapabilities: [provider('provider-a', ['manager-directive', 'worker-result'])],
      requirements: { requiredOutputProtocols: ['worker-result'] },
    });
    const first = router.route(base);
    expect(router.route(equivalent)).toEqual(first);
    expect(router.route({ ...base, agents: [{ ...baseAgent, routingPriority: 2 }] }).routePlanSha256)
      .not.toBe(first.routePlanSha256);
    expect(router.route({ ...base, task: { ...base.task, requiredCapabilities: ['A', 'B', 'C'] } }).routePlanSha256)
      .not.toBe(first.routePlanSha256);
    expect(router.route({ ...base, providerCapabilities: [provider('provider-a', ['worker-result'])] }).routePlanSha256)
      .not.toBe(first.routePlanSha256);
  });

  it.each([
    ['provider', agent({ provider: 'provider-b' }), [provider('provider-a'), provider('provider-b')]],
    ['projectId', agent({ projectId: null }), [provider()]],
    ['authority', agent({ authority: AgentAuthority.ADMIN }), [provider()]],
    ['allowedComplexities', agent({ allowedComplexities: [TaskComplexity.COMPLEX] }), [provider()]],
    ['allowedRiskLevels', agent({ allowedRiskLevels: [TaskRisk.HIGH] }), [provider()]],
    ['capabilities', agent({ capabilities: ['coding'] }), [provider()]],
    ['specialties', agent({ specialties: ['typescript'] }), [provider()]],
  ] as const)('binds the static agent %s field into route identity', (_field, changedAgent, providers) => {
    const baseline = route({ agents: [agent()], providerCapabilities: providers });
    const changed = route({ agents: [changedAgent], providerCapabilities: providers });
    expect(changed.routePlanSha256).not.toBe(baseline.routePlanSha256);
  });

  it('detaches caller collections, leaves inputs untouched, and deeply freezes the plan', () => {
    const taskCapabilities = ['coding'];
    const agentCapabilities = ['coding'];
    const agents = [agent({ capabilities: agentCapabilities })];
    const protocols: ('worker-result' | 'manager-directive')[] = ['worker-result'];
    const input = request({
      task: task({ requiredCapabilities: taskCapabilities }),
      agents,
      providerCapabilities: [provider('provider-a', protocols)],
      requirements: { requiredOutputProtocols: protocols },
    });
    const before = JSON.stringify(input);
    const plan = router.route(input);
    taskCapabilities.push('late');
    agentCapabilities.length = 0;
    agents.length = 0;
    protocols.push('manager-directive');
    expect(JSON.stringify(input)).not.toBe(before);
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['AGENT-A']);
    expect(plan.rejected).toEqual([]);
    expectDeepFrozen(plan);
  });

  it('reads every routing getter once, ignores free-text fields, and snapshots earlier arrays before later getters mutate them', () => {
    const counts = new Map<string, number>();
    const taskCapabilities = ['coding'];
    const taskValue = getters('task', {
      id: 'TASK-A', projectId: 'PROJECT-A', requiredCapabilities: taskCapabilities,
      requiredSpecialties: [], complexity: TaskComplexity.MEDIUM,
      risk: () => { taskCapabilities.push('late-required'); return TaskRisk.MEDIUM; },
      title: () => { throw new Error('title must not be read'); },
    }, counts) as unknown as Task;
    const agentCapabilities = ['coding'];
    const agentValue = getters('agent', {
      id: 'AGENT-A', projectId: 'PROJECT-A', provider: 'provider-a', status: AgentStatus.IDLE,
      allowedComplexities: [TaskComplexity.MEDIUM], allowedRiskLevels: [TaskRisk.MEDIUM],
      capabilities: agentCapabilities, specialties: [], authority: AgentAuthority.STANDARD,
      routingPriority: 1,
      enabled: () => { agentCapabilities.length = 0; return true; },
      model: () => { throw new Error('model must not be read'); },
      position: () => { throw new Error('position must not be read'); },
    }, counts) as unknown as Agent;
    const providerValue = getters('provider', {
      providerId: 'provider-a', outputProtocols: ['worker-result'],
    }, counts) as unknown as ProviderRoutingCapabilities;
    const requirementsValue = getters('requirements', {
      minimumAuthority: AgentAuthority.READ_ONLY, requiredOutputProtocols: ['worker-result'],
    }, counts);
    const requestValue = getters('request', {
      task: taskValue,
      agents: () => { taskCapabilities.push('request-late'); return [agentValue]; },
      providerCapabilities: [providerValue],
      requirements: requirementsValue,
    }, counts) as unknown as TaskRoutingRequest;
    const plan = router.route(requestValue);
    expect(plan.candidates.map(({ agentId }) => agentId)).toEqual(['AGENT-A']);
    for (const [key, count] of counts) {
      if (key === 'task.title' || key === 'agent.model' || key === 'agent.position') expect(count).toBe(0);
      else expect(count, key).toBe(1);
    }
  });

  it('normalizes a hostile getter failure without rereading it', () => {
    let reads = 0;
    const hostile = Object.defineProperty(request(), 'agents', {
      enumerable: true,
      get: () => { reads += 1; throw new Error('hostile getter'); },
    });
    expectRouterError(() => router.route(hostile), 'TASK_ROUTER_INVALID_REQUEST');
    expect(reads).toBe(1);
  });

  it.each([
    [null, 'TASK_ROUTER_INVALID_REQUEST'],
    [{}, 'TASK_ROUTER_INVALID_REQUEST'],
    [request({ task: task({ id: '' }) }), 'TASK_ROUTER_INVALID_REQUEST'],
    [request({ task: task({ requiredCapabilities: Array.from({ length: 257 }, (_, index) => `c${String(index)}`) }) }), 'TASK_ROUTER_LIMIT_EXCEEDED'],
    [request({ agents: Array.from({ length: 10_001 }, (_, index) => agent({ id: `a${String(index)}` })) }), 'TASK_ROUTER_LIMIT_EXCEEDED'],
    [request({ agents: [agent({ capabilities: Array.from({ length: 513 }, (_, index) => `c${String(index)}`) })] }), 'TASK_ROUTER_LIMIT_EXCEEDED'],
    [request({ providerCapabilities: [provider('provider-a', Array.from({ length: 33 }, () => 'worker-result'))] }), 'TASK_ROUTER_LIMIT_EXCEEDED'],
    [request({ task: task({ projectId: 'x'.repeat(257) }) }), 'TASK_ROUTER_LIMIT_EXCEEDED'],
    [request({ agents: [agent({ routingPriority: 1.5 })] }), 'TASK_ROUTER_INVALID_REQUEST'],
  ] as const)('rejects malformed or bounded request %#', (value, code) => {
    expectRouterError(() => router.route(value as TaskRoutingRequest), code);
  });
});

function route(overrides: Partial<TaskRoutingRequest> = {}): TaskRoutePlan {
  return router.route(request(overrides));
}

function request(overrides: Partial<TaskRoutingRequest> = {}): TaskRoutingRequest {
  return {
    task: task(),
    agents: [agent()],
    providerCapabilities: [provider()],
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-A', projectId: 'PROJECT-A', title: 'ignored', description: null,
    requiredCapabilities: [], requiredSpecialties: [], acceptanceCriteria: [], status: 'CREATED' as Task['status'],
    complexity: TaskComplexity.MEDIUM, risk: TaskRisk.MEDIUM, assignedAgentId: null, assignmentId: null,
    createdAt: 'ignored', updatedAt: 'ignored', ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'AGENT-A', projectId: 'PROJECT-A', name: 'ignored', provider: 'provider-a', model: 'ignored', position: 'ignored',
    status: AgentStatus.IDLE, allowedComplexities: [TaskComplexity.MEDIUM], allowedRiskLevels: [TaskRisk.MEDIUM],
    capabilities: [], specialties: [], authority: AgentAuthority.STANDARD, routingPriority: 1, enabled: true,
    createdAt: 'ignored', updatedAt: 'ignored', ...overrides,
  };
}

function provider(
  providerId = 'provider-a',
  outputProtocols: ProviderRoutingCapabilities['outputProtocols'] = ['worker-result'],
): ProviderRoutingCapabilities {
  return { providerId, outputProtocols };
}

function reasonFor(plan: TaskRoutePlan, agentId: string): readonly string[] | undefined {
  return plan.rejected.find((rejection) => rejection.agentId === agentId)?.reasons;
}

function expectDeepFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) expectDeepFrozen(nested);
  }
}

function getters(
  prefix: string,
  values: Readonly<Record<string, unknown>>,
  counts: Map<string, number>,
): object {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(values)) {
    const name = `${prefix}.${key}`;
    counts.set(name, 0);
    descriptors[key] = {
      enumerable: true,
      get: () => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return isGetterFactory(value) ? value() : value;
      },
    };
  }
  return Object.defineProperties({}, descriptors);
}

function isGetterFactory(value: unknown): value is () => unknown { return typeof value === 'function'; }

function expectRouterError(callback: () => unknown, code: string): void {
  let caught: unknown;
  try { callback(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code });
}
