import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Agent } from '../core/types.js';

export interface AgentProfileManagerOptions {
  readonly agentsDirectory?: string;
}

export class AgentProfileManager {
  readonly #agentsDirectory: string;

  public constructor(options: AgentProfileManagerOptions = {}) {
    this.#agentsDirectory = options.agentsDirectory ?? join(process.cwd(), 'data', 'agents');
  }

  public profilePath(agentId: string): string {
    return join(this.#agentsDirectory, agentId, 'AGENT.md');
  }

  public writeProfile(agent: Agent, userRules = ''): string {
    const profilePath = this.profilePath(agent.id);
    mkdirSync(join(this.#agentsDirectory, agent.id), { recursive: true });
    writeFileSync(profilePath, this.render(agent, userRules), 'utf8');
    return profilePath;
  }

  public readProfile(agentId: string): string {
    return readFileSync(this.profilePath(agentId), 'utf8');
  }

  public removeProfile(agentId: string): void {
    rmSync(join(this.#agentsDirectory, agentId), { recursive: true, force: true });
  }

  public calculateProfileHash(agent: Agent): string {
    const config = {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      position: agent.position,
      status: agent.status,
      allowedComplexities: agent.allowedComplexities,
      allowedRiskLevels: agent.allowedRiskLevels,
      capabilities: agent.capabilities,
      specialties: agent.specialties,
      authority: agent.authority,
      routingPriority: agent.routingPriority,
      enabled: agent.enabled,
    };
    const content = this.readProfile(agent.id);
    return createHash('sha256').update(`${JSON.stringify(config)}\n${content}`).digest('hex');
  }

  public userRules(agentId: string): string {
    const content = this.readProfile(agentId);
    const marker = '## 用户自定义规则\n';
    const start = content.indexOf(marker);
    if (start < 0) return '';
    return content.slice(start + marker.length).trim();
  }

  private render(agent: Agent, userRules: string): string {
    const list = (values: readonly string[]) =>
      values.length === 0 ? '- 无' : values.map((value) => `- ${value}`).join('\n');
    return (
      `# Agent Profile: ${agent.name}\n\n` +
      `## 身份\n\n- ID: ${agent.id}\n- Provider: ${agent.provider}\n- Model: ${agent.model}\n\n` +
      `## 职位\n\n${agent.position}\n\n` +
      `## 任务难度范围\n\n${list(agent.allowedComplexities)}\n\n` +
      `## 风险范围\n\n${list(agent.allowedRiskLevels)}\n\n` +
      `## 能力\n\n${list(agent.capabilities)}\n\n` +
      `## Authority\n\n${agent.authority}\n\n` +
      `## Specialties\n\n${list(agent.specialties)}\n\n` +
      `## 工作规则\n\n- 遵守 AgentHub 任务和权限边界。\n- 仅接受配置允许的难度和风险等级。\n\n` +
      `## 用户自定义规则\n\n${userRules.trim()}\n`
    );
  }
}
