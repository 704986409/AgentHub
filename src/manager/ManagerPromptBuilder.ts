import { createHash } from 'node:crypto';

import {
  ManagerPromptValidationError,
  validateManagerPromptEnvelope,
  type ManagerPromptEnvelope,
} from '../protocol/PromptEnvelope.js';
import type { ManagerPromptDiagnosticRecorder } from './ManagerPromptDiagnostics.js';

const managerInstructions = [
  'Inspect only repository content relevant to the requirement.',
  'Act as Development Manager, not the primary implementation engineer.',
  'Minimize scope creep.',
  'Produce exactly one final <AGENTHUB_DIRECTIVE> block.',
  'The directive JSON must include action, taskId, title, instructions, acceptanceCriteria, issues, requestedChecks, and summary.',
  'Use a string for every directive text field and an array of strings for acceptanceCriteria, issues, and requestedChecks.',
  'The directive action must be one of DELEGATE, REQUEST_REVISION, ACCEPT, BLOCK, or INFORM.',
  'Do not modify role/job-definition files as part of task execution.',
  'Do not modify Markdown files unless a future task explicitly authorizes documentation work.',
] as const;

export class ManagerPromptBuilder {
  public constructor(private readonly diagnostics?: ManagerPromptDiagnosticRecorder) {}

  public build(envelope: ManagerPromptEnvelope): string {
    this.diagnostics?.record('manager_prompt.build.start', envelopePresence(envelope));
    try {
      validateManagerPromptEnvelope(envelope);
    } catch (error) {
      this.diagnostics?.record('manager_prompt.validation_failed', {
        code: error instanceof ManagerPromptValidationError ? error.code : 'UNKNOWN_VALIDATION_ERROR',
      });
      throw error;
    }

    const sections = [
      jsonSection('AGENTHUB_MANAGER_ROLE_JSON', { text: envelope.rolePrompt }),
      jsonSection('PROJECT_JSON', {
        workspace: envelope.project.workspacePath,
        targetBranch: envelope.project.targetBranch,
        repositoryRules: envelope.project.repositoryRules,
      }),
      jsonSection('USER_REQUIREMENT_JSON', { text: envelope.userRequirement }),
    ];
    if (envelope.task !== undefined) sections.push(jsonSection('CURRENT_TASK_JSON', envelope.task));
    sections.push([
      '[AGENTHUB_INSTRUCTIONS]',
      ...managerInstructions.map((instruction) => `- ${instruction}`),
      '[/AGENTHUB_INSTRUCTIONS]',
    ].join('\n'));
    const prompt = sections.join('\n\n');

    this.diagnostics?.record('manager_prompt.build.success', {
      workspace: envelope.project.workspacePath,
      targetBranch: envelope.project.targetBranch,
      repositoryRuleCount: envelope.project.repositoryRules.length,
      requirementChars: envelope.userRequirement.length,
      rolePromptChars: envelope.rolePrompt.length,
      rolePromptHash: sha256(envelope.rolePrompt),
      promptChars: prompt.length,
      hasTask: envelope.task !== undefined,
      ...(envelope.task?.taskId === undefined ? {} : { taskId: envelope.task.taskId }),
    });
    return prompt;
  }
}

function jsonSection(name: string, value: unknown): string {
  return [`[${name}]`, JSON.stringify(value), `[/${name}]`].join('\n');
}

function envelopePresence(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return { envelopePresent: false };
  const record = value as Record<string, unknown>;
  return {
    envelopePresent: true,
    hasRolePrompt: typeof record.rolePrompt === 'string',
    hasProject: typeof record.project === 'object' && record.project !== null,
    hasUserRequirement: typeof record.userRequirement === 'string',
    hasTask: record.task !== undefined,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
