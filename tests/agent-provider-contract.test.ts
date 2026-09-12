import { describe, expect, it } from 'vitest';

import {
  AgentProviderError,
  agentOutputProtocols,
  validateAgentProviderTurnRequest,
  type AgentManagerDirectiveTurnResult,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderSession,
  type AgentProviderTurnRequest,
  type AgentProviderTurnResult,
  type AgentWorkerResultTurnFailure,
  type AgentWorkerResultTurnSuccess,
} from '../src/index.js';

const hybridCapabilities: AgentProviderCapabilities = {
  outputProtocols: ['manager-directive', 'worker-result'],
  sessionContinuation: true,
};

describe('agent provider contract', () => {
  it('keeps provider identity independent of role and permits both structured protocols', () => {
    const provider = contractProvider('hybrid-test', hybridCapabilities);
    expect(provider.id).toBe('hybrid-test');
    expect(provider.capabilities.outputProtocols).toEqual(['manager-directive', 'worker-result']);
    expect(provider).not.toHaveProperty('role');
    expect(provider).not.toHaveProperty('isManager');
    expect(provider).not.toHaveProperty('isWorker');
  });

  it('keeps the canonical protocol vocabulary immutable at runtime', () => {
    expect(Object.isFrozen(agentOutputProtocols)).toBe(true);
    expect(() => (agentOutputProtocols as unknown as string[]).push('future-protocol')).toThrow();
    expect(agentOutputProtocols).toEqual(['manager-directive', 'worker-result']);
  });

  it('models manager directive results without provider-private output', () => {
    const result: AgentManagerDirectiveTurnResult = {
      providerId: 'hybrid-test',
      protocol: 'manager-directive',
      directiveStatus: 'invalid',
      directive: null,
      failure: { kind: 'malformed_json', message: 'Invalid directive' },
    };
    expect(result).toEqual(expect.objectContaining({ protocol: 'manager-directive', directive: null }));
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('threadId');
    expect(result).not.toHaveProperty('repairText');
  });

  it('models worker success and failure as a strict protocol-validity union', () => {
    const success: AgentWorkerResultTurnSuccess = {
      providerId: 'hybrid-test',
      protocol: 'worker-result',
      protocolValid: true,
      workerResult: {
        protocolVersion: 1,
        outcome: 'COMPLETED',
        summary: 'done',
        changedFiles: [],
        checks: [],
        blockers: [],
        questions: [],
        risks: [],
        notes: [],
      },
    };
    const failure: AgentWorkerResultTurnFailure = {
      providerId: 'hybrid-test',
      protocol: 'worker-result',
      protocolValid: false,
      failure: { kind: 'missing_result', message: 'Missing result' },
    };
    const results: AgentProviderTurnResult[] = [success, failure];
    expect(results[0]).toHaveProperty('workerResult');
    expect(results[1]).not.toHaveProperty('workerResult');
    expect(results.every((result) => !('processId' in result) && !('transport' in result))).toBe(true);
  });

  it.each(['', ' ', '\r\n'])('rejects blank prompt %j before execution', (prompt) => {
    expectProviderError(
      () => validateAgentProviderTurnRequest({ prompt, protocol: 'worker-result' }, hybridCapabilities),
      'AGENT_PROVIDER_CONTRACT_VIOLATION',
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timeout %s before execution',
    (timeoutMs) => {
      expectProviderError(
        () => validateAgentProviderTurnRequest(
          { prompt: 'valid', protocol: 'worker-result', timeoutMs },
          hybridCapabilities,
        ),
        'AGENT_PROVIDER_CONTRACT_VIOLATION',
      );
    },
  );

  it('rejects an unsupported protocol without substitution', () => {
    const workerOnly: AgentProviderCapabilities = {
      outputProtocols: ['worker-result'],
      sessionContinuation: true,
    };
    const request: AgentProviderTurnRequest = { prompt: 'plan', protocol: 'manager-directive' };
    expectProviderError(
      () => validateAgentProviderTurnRequest(request, workerOnly),
      'AGENT_PROVIDER_UNSUPPORTED_PROTOCOL',
    );
    expect(request.protocol).toBe('manager-directive');
  });

  it.each(['manager-directive', 'worker-result'] as const)(
    'accepts supported %s requests without executing a provider',
    (protocol) => {
      expect(() => validateAgentProviderTurnRequest(
        { prompt: 'execute', protocol, timeoutMs: 1 },
        hybridCapabilities,
      )).not.toThrow();
    },
  );
});

function contractProvider(id: string, capabilities: AgentProviderCapabilities): AgentProvider {
  return {
    id,
    capabilities,
    createSession: () => contractSession(id, capabilities),
  };
}

function contractSession(providerId: string, capabilities: AgentProviderCapabilities): AgentProviderSession {
  return {
    providerId,
    capabilities,
    started: false,
    active: false,
    sessionId: undefined,
    start: () => Promise.resolve(),
    runTurn: () => Promise.reject(new Error('not executed')),
    shutdown: () => Promise.resolve(),
  };
}

function expectProviderError(callback: () => void, code: AgentProviderError['code']): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentProviderError);
  expect(caught).toMatchObject({ code });
}
