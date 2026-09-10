import { ManagerDirectiveParser, type ManagerDirective, type ManagerDirectiveFailureKind } from '../../protocol/index.js';
import type { CodexDiagnostics } from './CodexDiagnostics.js';
import type { CodexTurnRequest, CodexTurnResult } from './CodexManagerTurn.js';

export type DirectiveStatus = 'valid' | 'repaired' | 'invalid';

export type ManagerDirectiveTurnFailureKind =
  | ManagerDirectiveFailureKind
  | 'initial_turn_failed'
  | 'repair_turn_failed';

export interface ManagerDirectiveTurnResult {
  initialTurn: CodexTurnResult;
  repairTurn?: CodexTurnResult;
  directive: ManagerDirective | null;
  directiveStatus: DirectiveStatus;
  failure?: {
    kind: ManagerDirectiveTurnFailureKind;
    message: string;
  };
}

export interface CodexDirectiveTurnExecutor {
  runTurn(request: CodexTurnRequest): Promise<CodexTurnResult>;
}

export class CodexManagerDirectiveRunner {
  readonly #parser = new ManagerDirectiveParser();

  public constructor(
    private readonly turns: CodexDirectiveTurnExecutor,
    private readonly diagnostics?: CodexDiagnostics,
  ) {}

  public async run(request: CodexTurnRequest): Promise<ManagerDirectiveTurnResult> {
    const initialTurn = await this.turns.runTurn(request);
    if (initialTurn.status !== 'completed') {
      return {
        initialTurn,
        directive: null,
        directiveStatus: 'invalid',
        failure: { kind: 'initial_turn_failed', message: `Initial Manager turn ended with status ${initialTurn.status}` },
      };
    }

    const firstParse = this.parseTurn(initialTurn, 0);
    if (firstParse.success) {
      return { initialTurn, directive: firstParse.directive, directiveStatus: 'valid' };
    }

    this.diagnostics?.record('directive.repair.start', {
      threadId: initialTurn.threadId,
      turnId: initialTurn.turnId,
      repairAttempt: 1,
      failureKind: firstParse.failure.kind,
    });
    const repairTurn = await this.turns.runTurn({
      prompt: createRepairPrompt(firstParse.failure.kind, firstParse.failure.message),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    if (repairTurn.status !== 'completed') {
      this.diagnostics?.record('directive.repair.failure', {
        threadId: repairTurn.threadId,
        turnId: repairTurn.turnId,
        repairAttempt: 1,
        failureKind: 'repair_turn_failed',
        turnStatus: repairTurn.status,
      });
      return {
        initialTurn,
        repairTurn,
        directive: null,
        directiveStatus: 'invalid',
        failure: { kind: 'repair_turn_failed', message: `Repair turn ended with status ${repairTurn.status}` },
      };
    }

    const repairParse = this.parseTurn(repairTurn, 1);
    if (repairParse.success) {
      this.diagnostics?.record('directive.repair.completed', {
        threadId: repairTurn.threadId,
        turnId: repairTurn.turnId,
        repairAttempt: 1,
        action: repairParse.directive.action,
        taskId: repairParse.directive.taskId,
      });
      return { initialTurn, repairTurn, directive: repairParse.directive, directiveStatus: 'repaired' };
    }

    this.diagnostics?.record('directive.repair.failure', {
      threadId: repairTurn.threadId,
      turnId: repairTurn.turnId,
      repairAttempt: 1,
      failureKind: repairParse.failure.kind,
    });
    return {
      initialTurn,
      repairTurn,
      directive: null,
      directiveStatus: 'invalid',
      failure: repairParse.failure,
    };
  }

  private parseTurn(turn: CodexTurnResult, repairAttempt: 0 | 1) {
    this.diagnostics?.record('directive.parse.start', {
      threadId: turn.threadId,
      turnId: turn.turnId,
      repairAttempt,
    });
    const result = this.#parser.parse(turn.text);
    if (result.success) {
      this.diagnostics?.record('directive.parse.success', {
        threadId: turn.threadId,
        turnId: turn.turnId,
        repairAttempt,
        action: result.directive.action,
        taskId: result.directive.taskId,
      });
    } else {
      this.diagnostics?.record('directive.parse.failure', {
        threadId: turn.threadId,
        turnId: turn.turnId,
        repairAttempt,
        failureKind: result.failure.kind,
      });
    }
    return result;
  }
}

export function createRepairPrompt(kind: ManagerDirectiveFailureKind, message: string): string {
  return [
    'Your previous response did not contain exactly one valid AgentHub control block.',
    'Return only one corrected control block in this exact form:',
    '<AGENTHUB_DIRECTIVE>',
    '{ valid JSON }',
    '</AGENTHUB_DIRECTIVE>',
    'Do not add prose outside the block.',
    `Validation error (${kind}): ${message}`,
  ].join('\n');
}
