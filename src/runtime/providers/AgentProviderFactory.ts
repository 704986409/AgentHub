import {
  AgentProviderError,
  agentOutputProtocols,
  type AgentOutputProtocol,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderDescriptor,
  type AgentProviderId,
  type AgentProviderSession,
  type CreateAgentProviderSessionRequest,
} from './AgentProvider.js';

interface RegisteredProvider {
  readonly provider: AgentProvider;
  readonly descriptor: AgentProviderDescriptor;
}

const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Instance-local provider construction registry. Provider selection is explicit and
 * independent of organizational role; this factory does not own session lifecycle.
 */
export class AgentProviderFactory {
  readonly #providers = new Map<AgentProviderId, RegisteredProvider>();

  public register(provider: AgentProvider): void {
    if (!isRecord(provider) || typeof provider.createSession !== 'function') {
      throw contractViolation('Agent provider must implement createSession');
    }
    validateProviderId(provider.id);
    if (this.#providers.has(provider.id)) {
      throw new AgentProviderError(
        'AGENT_PROVIDER_DUPLICATE',
        `Agent provider ${provider.id} is already registered`,
      );
    }
    const capabilities = snapshotCapabilities(provider.capabilities);
    const descriptor = Object.freeze({ id: provider.id, capabilities });
    this.#providers.set(provider.id, { provider, descriptor });
  }

  public has(providerId: AgentProviderId): boolean {
    return this.#providers.has(providerId);
  }

  public list(): readonly AgentProviderDescriptor[] {
    return Object.freeze([...this.#providers.values()].map(({ descriptor }) => copyDescriptor(descriptor)));
  }

  public createSession(
    providerId: AgentProviderId,
    request: CreateAgentProviderSessionRequest,
  ): AgentProviderSession {
    validateProviderId(providerId);
    const registered = this.#providers.get(providerId);
    if (registered === undefined) {
      throw new AgentProviderError(
        'AGENT_PROVIDER_NOT_FOUND',
        `Agent provider ${providerId} is not registered`,
      );
    }
    if (!isRecord(request) || !isRecord(request.context)) {
      throw contractViolation('Agent provider session request is invalid');
    }
    const context = Object.freeze({ ...request.context, provider: registered.descriptor.id });
    const config = request.config === undefined ? undefined : snapshotConfig(request.config);
    const session = registered.provider.createSession({
      eventBus: request.eventBus,
      context,
      ...(config === undefined ? {} : { config }),
    });
    validateSession(session, registered.descriptor);
    return session;
  }
}

function validateProviderId(providerId: unknown): asserts providerId is AgentProviderId {
  if (typeof providerId !== 'string' || !providerIdPattern.test(providerId)) {
    throw new AgentProviderError(
      'AGENT_PROVIDER_INVALID_ID',
      'Agent provider ID must be a canonical lowercase identifier of 1 to 64 characters',
    );
  }
}

function snapshotCapabilities(value: unknown): AgentProviderCapabilities {
  if (!isRecord(value) || typeof value.sessionContinuation !== 'boolean' ||
    !Array.isArray(value.outputProtocols) || value.outputProtocols.length === 0) {
    throw invalidCapabilities();
  }
  const protocols: AgentOutputProtocol[] = [];
  const seen = new Set<AgentOutputProtocol>();
  for (const protocol of value.outputProtocols) {
    if (typeof protocol !== 'string' || !agentOutputProtocols.includes(protocol as AgentOutputProtocol)) {
      throw invalidCapabilities();
    }
    const knownProtocol = protocol as AgentOutputProtocol;
    if (seen.has(knownProtocol)) throw invalidCapabilities();
    seen.add(knownProtocol);
    protocols.push(knownProtocol);
  }
  return Object.freeze({
    outputProtocols: Object.freeze(protocols),
    sessionContinuation: value.sessionContinuation,
  });
}

function validateSession(value: unknown, descriptor: AgentProviderDescriptor): asserts value is AgentProviderSession {
  if (!isRecord(value) || value.providerId !== descriptor.id ||
    typeof value.start !== 'function' || typeof value.runTurn !== 'function' ||
    typeof value.shutdown !== 'function' || typeof value.started !== 'boolean' ||
    typeof value.active !== 'boolean' ||
    (value.sessionId !== undefined && typeof value.sessionId !== 'string')) {
    throw contractViolation('Agent provider returned an invalid session contract');
  }
  let capabilities: AgentProviderCapabilities;
  try {
    capabilities = snapshotCapabilities(value.capabilities);
  } catch {
    throw contractViolation('Agent provider session capabilities are invalid');
  }
  if (capabilities.sessionContinuation !== descriptor.capabilities.sessionContinuation ||
    capabilities.outputProtocols.length !== descriptor.capabilities.outputProtocols.length ||
    capabilities.outputProtocols.some((protocol) =>
      !descriptor.capabilities.outputProtocols.includes(protocol))) {
    throw contractViolation('Agent provider session capabilities do not match registration');
  }
}

function snapshotConfig(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw contractViolation('Agent provider config must be an object');
  return Object.freeze({ ...value });
}

function copyDescriptor(descriptor: AgentProviderDescriptor): AgentProviderDescriptor {
  return Object.freeze({
    id: descriptor.id,
    capabilities: Object.freeze({
      outputProtocols: Object.freeze([...descriptor.capabilities.outputProtocols]),
      sessionContinuation: descriptor.capabilities.sessionContinuation,
    }),
  });
}

function invalidCapabilities(): AgentProviderError {
  return new AgentProviderError(
    'AGENT_PROVIDER_INVALID_CAPABILITIES',
    'Agent provider capabilities must declare unique supported output protocols',
  );
}

function contractViolation(message: string): AgentProviderError {
  return new AgentProviderError('AGENT_PROVIDER_CONTRACT_VIOLATION', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
