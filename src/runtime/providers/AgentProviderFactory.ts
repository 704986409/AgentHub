import {
  AgentProviderError,
  agentOutputProtocols,
  type AgentOutputProtocol,
  type AgentProvider,
  type AgentProviderCapabilities,
  type AgentProviderDescriptor,
  type AgentProviderId,
  type AgentProviderSession,
  type AgentProviderSessionCreateOptions,
  type CreateAgentProviderSessionRequest,
} from './AgentProvider.js';

interface RegisteredProvider {
  readonly createSession: (
    options: AgentProviderSessionCreateOptions,
  ) => AgentProviderSession;
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
    if (!isRecord(provider)) {
      throw contractViolation('Agent provider must implement createSession');
    }
    const id = provider.id;
    const rawCapabilities = provider.capabilities;
    const createSession: unknown = Reflect.get(provider, 'createSession');
    validateProviderId(id);
    const capabilities = snapshotCapabilities(rawCapabilities);
    if (typeof createSession !== 'function') {
      throw contractViolation('Agent provider must implement createSession');
    }
    if (this.#providers.has(id)) {
      throw new AgentProviderError(
        'AGENT_PROVIDER_DUPLICATE',
        `Agent provider ${id} is already registered`,
      );
    }
    const descriptor = Object.freeze({ id, capabilities });
    const createRegisteredSession = (options: AgentProviderSessionCreateOptions): AgentProviderSession =>
      Reflect.apply(createSession, provider, [options]) as AgentProviderSession;
    this.#providers.set(id, { createSession: createRegisteredSession, descriptor });
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
    if (!isRecord(request)) {
      throw contractViolation('Agent provider session request is invalid');
    }
    const eventBus = request.eventBus;
    const rawContext = request.context;
    const rawConfig = request.config;
    if (!isRecord(rawContext)) throw contractViolation('Agent provider session request is invalid');
    const context = Object.freeze({ ...rawContext, provider: registered.descriptor.id });
    const config = rawConfig === undefined ? undefined : snapshotConfig(rawConfig);
    const session = registered.createSession({
      eventBus,
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
  if (!isRecord(value)) {
    throw invalidCapabilities();
  }
  const sessionContinuation = value.sessionContinuation;
  const outputProtocols = value.outputProtocols;
  if (typeof sessionContinuation !== 'boolean' ||
    !Array.isArray(outputProtocols) || outputProtocols.length === 0) throw invalidCapabilities();
  const protocols: AgentOutputProtocol[] = [];
  const seen = new Set<AgentOutputProtocol>();
  for (const protocol of outputProtocols) {
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
    sessionContinuation,
  });
}

function validateSession(value: unknown, descriptor: AgentProviderDescriptor): asserts value is AgentProviderSession {
  if (!isRecord(value)) throw contractViolation('Agent provider returned an invalid session contract');
  const providerId = value.providerId;
  const start = value.start;
  const runTurn = value.runTurn;
  const shutdown = value.shutdown;
  const started = value.started;
  const active = value.active;
  const sessionId = value.sessionId;
  const rawCapabilities = value.capabilities;
  if (providerId !== descriptor.id || typeof start !== 'function' || typeof runTurn !== 'function' ||
    typeof shutdown !== 'function' || typeof started !== 'boolean' || typeof active !== 'boolean' ||
    (sessionId !== undefined && typeof sessionId !== 'string')) {
    throw contractViolation('Agent provider returned an invalid session contract');
  }
  let capabilities: AgentProviderCapabilities;
  try {
    capabilities = snapshotCapabilities(rawCapabilities);
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
