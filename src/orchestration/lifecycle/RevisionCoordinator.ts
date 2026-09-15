import type { Task } from '../../core/types.js';
import type { AgentPool } from '../../runtime/AgentPool.js';
import type { AgentProviderTurnResult } from '../../runtime/providers/AgentProvider.js';
import { snapshotAssignmentTurnResult } from '../AssignmentDispatcher.js';
import { lifecycleError } from './TaskLifecycleContract.js';
import type { ReviewEvidence } from '../../workspace/index.js';

const maxRevisionPromptBytes = 1024 * 1024;

export interface RevisionCoordinatorPlan {
  readonly taskId: string;
  readonly agentId: string;
  readonly assignmentId: string;
  readonly providerId: string;
  readonly prompt: string;
}

export interface RevisionCoordinatorBinding {
  readonly taskId: string;
  readonly agentId: string;
  readonly assignmentId: string;
  readonly providerId: string;
}

/** Coordinates one revision prompt and one provider turn without owning lifecycle state. */
export class RevisionCoordinator {
  readonly #pool: AgentPool;

  public constructor(agentPool: AgentPool) {
    this.#pool = agentPool;
  }

  public prepare(review: ReviewEvidence, task: Task, binding: RevisionCoordinatorBinding): RevisionCoordinatorPlan {
    const prompt = revisionPrompt(review, task);
    return Object.freeze({
      taskId: binding.taskId,
      agentId: binding.agentId,
      assignmentId: binding.assignmentId,
      providerId: binding.providerId,
      prompt,
    });
  }

  public async run(plan: RevisionCoordinatorPlan): Promise<AgentProviderTurnResult> {
    let raw: AgentProviderTurnResult;
    try {
      raw = await this.#pool.runTurn(plan.agentId, plan.assignmentId, {
        prompt: plan.prompt,
        protocol: 'worker-result',
      });
    } catch {
      throw new RevisionTurnError();
    }
    try {
      return snapshotAssignmentTurnResult(raw, 'worker-result', plan.providerId);
    } catch {
      return {
        protocol: 'worker-result',
        protocolValid: false,
        providerId: plan.providerId,
        failure: { kind: 'schema_invalid', message: 'invalid revision result' },
      };
    }
  }
}

export class RevisionTurnError extends Error {
  public constructor() {
    super('revision turn failed');
    this.name = 'RevisionTurnError';
  }
}

function revisionPrompt(review: ReviewEvidence, task: Task): string {
  const lines = ['Apply exactly one revision for the current task.', '', `Review summary: ${review.summary}`,
    '', 'Findings:'];
  if (review.findings.length === 0) lines.push('(none)');
  for (const finding of review.findings) lines.push(
    `- [${finding.severity}] ${finding.code}: ${finding.message}${finding.path === undefined ? '' : ` (${finding.path})`}`,
  );
  lines.push('', 'Acceptance criteria:');
  if (task.acceptanceCriteria.length === 0) lines.push('(none)');
  else task.acceptanceCriteria.forEach((criterion, index) => lines.push(`${String(index + 1)}. ${criterion}`));
  const prompt = lines.join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > maxRevisionPromptBytes) {
    throw lifecycleError('TASK_LIFECYCLE_INVALID_REQUEST');
  }
  return prompt;
}
