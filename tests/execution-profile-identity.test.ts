import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentAuthority,
  AgentProfileManager,
  AgentRegistry,
  AgentStatus,
  Database,
  SqliteAgentRepository,
} from '../src/index.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

describe('stable execution profile identity', () => {
  it('ignores status and routing priority but detects execution config and user-rule drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenthub-execution-profile-'));
    const database = new Database(join(directory, 'agenthub.db'));
    database.initialize();
    const registry = new AgentRegistry(
      new SqliteAgentRepository(database),
      new AgentProfileManager({ agentsDirectory: join(directory, 'agents') }),
    );
    registry.createAgent({
      id: 'agent-a', name: 'Agent', provider: 'fake', model: 'model', position: 'Developer',
      status: AgentStatus.IDLE, authority: AgentAuthority.STANDARD, capabilities: ['coding'],
      specialties: ['typescript'], enabled: true,
    }, 'original rule');
    const initial = registry.calculateExecutionProfileHash('agent-a');
    registry.updateAgent('agent-a', { status: AgentStatus.BUSY, routingPriority: 99 });
    expect(registry.calculateExecutionProfileHash('agent-a')).toBe(initial);
    registry.updateAgent('agent-a', { status: AgentStatus.IDLE });

    const changes = [
      () => registry.updateAgent('agent-a', { model: 'other-model' }),
      () => registry.updateAgent('agent-a', { position: 'Reviewer' }),
      () => registry.updateAgent('agent-a', { authority: AgentAuthority.PRIVILEGED }),
      () => registry.updateAgent('agent-a', { capabilities: ['review'] }),
      () => registry.updateAgent('agent-a', { specialties: ['security'] }),
      () => registry.updateAgent('agent-a', { enabled: false }),
      () => registry.updateAgent('agent-a', {}, 'changed rule'),
    ];
    let previous = initial;
    for (const change of changes) {
      change();
      const current = registry.calculateExecutionProfileHash('agent-a');
      expect(current).not.toBe(previous);
      previous = current;
    }
    database.close();
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  });
});
