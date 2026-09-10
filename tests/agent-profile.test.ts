import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentProfileManager,
  AgentRegistry,
  AgentStatus,
  Database,
  SqliteAgentRepository,
  TaskComplexity,
  TaskRisk,
} from '../src/index.js';

describe('Agent Profile System', () => {
  let database: Database;
  let directory: string;
  let registry: AgentRegistry;
  let profiles: AgentProfileManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agenthub-profile-'));
    database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    profiles = new AgentProfileManager({ agentsDirectory: join(directory, 'data', 'agents') });
    registry = new AgentRegistry(new SqliteAgentRepository(database), profiles);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates an agent and its independent AGENT.md', () => {
    const agent = registry.createAgent(
      {
        id: 'codex-director',
        name: 'Codex Director',
        provider: 'Codex',
        model: 'gpt-5',
        position: 'Manager',
        allowedComplexities: [TaskComplexity.COMPLEX],
        allowedRiskLevels: [TaskRisk.LOW],
        capabilities: ['planning'],
        specialties: ['architecture'],
        authority: AgentAuthority.ADMIN,
        routingPriority: 10,
      },
      'Prefer concise decisions.',
    );
    const profile = profiles.readProfile(agent.id);

    expect(profile).toContain('Codex Director');
    expect(profile).toContain('Manager');
    expect(profile).toContain('COMPLEX');
    expect(profile).toContain('LOW');
    expect(profile).toContain('planning');
    expect(profile).toContain('ADMIN');
    expect(profile).toContain('Prefer concise decisions.');
    expect(profiles.profilePath(agent.id)).toContain(join('codex-director', 'AGENT.md'));
  });

  it('updates the profile when position or capabilities change', () => {
    const agent = registry.createAgent({ name: 'Developer', provider: 'Claude', model: 'sonnet', position: 'Developer' });
    registry.updateAgent(agent.id, { position: 'Core Developer', capabilities: ['coding', 'review'] });
    const profile = readFileSync(profiles.profilePath(agent.id), 'utf8');

    expect(profile).toContain('Core Developer');
    expect(profile).toContain('coding');
    expect(profile).toContain('review');
  });

  it('keeps different agents in different profile files', () => {
    const first = registry.createAgent({ name: 'One', provider: 'Codex', model: 'm1', position: 'Manager' });
    const second = registry.createAgent({ name: 'Two', provider: 'Claude', model: 'm2', position: 'Developer' });

    expect(profiles.profilePath(first.id)).not.toBe(profiles.profilePath(second.id));
    expect(profiles.readProfile(first.id)).toContain('Manager');
    expect(profiles.readProfile(second.id)).toContain('Developer');
  });

  it('allows editing and deletion while IDLE', () => {
    const agent = registry.createAgent({ name: 'Idle', provider: 'Codex', model: 'm', position: 'Role' });
    const updated = registry.updateAgent(agent.id, { model: 'new-model' });
    expect(updated.model).toBe('new-model');
    registry.deleteAgent(agent.id);
    expect(registry.getAgent(agent.id)).toBeNull();
  });

  it('locks profile edits and deletion while BUSY', () => {
    const agent = registry.createAgent({ name: 'Busy', provider: 'Codex', model: 'm', position: 'Role' });
    registry.updateAgent(agent.id, { status: AgentStatus.BUSY });

    expect(() => registry.updateAgent(agent.id, { position: 'New role' })).toThrow(/BUSY/);
    expect(() => registry.updateAgent(agent.id, { model: 'new-model' })).toThrow(/BUSY/);
    expect(() => registry.updateAgent(agent.id, { allowedComplexities: [TaskComplexity.CRITICAL] })).toThrow(/BUSY/);
    expect(() => registry.updateAgent(agent.id, { authority: AgentAuthority.ADMIN })).toThrow(/BUSY/);
    expect(() => registry.deleteAgent(agent.id)).toThrow(/BUSY/);
    expect(registry.getAgent(agent.id)?.status).toBe(AgentStatus.BUSY);
  });

  it('produces a stable SHA-256 profile hash', () => {
    const agent = registry.createAgent({ name: 'Hashed', provider: 'Codex', model: 'm', position: 'Role' });
    const first = registry.calculateProfileHash(agent.id);
    const second = registry.calculateProfileHash(agent.id);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    registry.updateAgent(agent.id, { specialties: ['new specialty'] });
    expect(registry.calculateProfileHash(agent.id)).not.toBe(first);
  });
});
