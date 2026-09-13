export * from './GitCommandRunner.js';
export { GitWorktreeManager, GitWorktreeError, validateTaskId, parseWorktreePorcelain } from './GitWorktreeManager.js';
export type { GitWorktreeErrorCode, GitWorktreeManagerOptions, CreateTaskWorkspaceRequest,
  TaskWorkspace, CreatedTaskWorkspace, GitWorktreeRecord } from './GitWorktreeManager.js';
export { TaskCommandRunner, TaskCommandRunnerError } from './TaskCommandRunner.js';
export type { TaskCommandRunSpec, CommandStreamEvidence, TaskCommandOutcome,
  TaskCommandRunResult, TaskCommandRunnerOptions } from './TaskCommandRunner.js';
export { BuildTestEvidenceError } from './BuildTestEvidenceCollector.js';
export type { EvidenceCommandPhase, EvidenceCommandSpec, BuildTestEvidencePlan,
  CommandEvidence, BuildTestEvidence, SourceAfterEvidence, VisibilityAfterEvidence } from './BuildTestEvidenceCollector.js';
export { GitChangeCaptureError, canonicalTrackedIdentity } from './GitWorkspaceChangeCapture.js';
export type { CaptureWorkspaceChangesOptions, GitChangeCaptureErrorCode, GitWorkingFileFingerprint,
  GitTrackedChange, CanonicalTrackedIdentity, GitPatchCapture, GitChangeLayer, GitStatusEntry,
  GitWorkspaceChangeSnapshot,
} from './GitWorkspaceChangeCapture.js';

export { ReviewEvidenceError, createReviewEvidence } from './ReviewEvidence.js';
export type { ReviewVerdict, ReviewFindingSeverity, ReviewFindingInput, ReviewDecisionInput,
  ReviewFinding, ReviewEvidence } from './ReviewEvidence.js';
export { snapshotMergeGateDecision } from './MergeGate.js';
export type { MergeGatePolicy, MergeGateReason, MergeGateDecision } from './MergeGate.js';

export { GitMergeError } from './GitMergeIntegration.js';
export type { GitMergeErrorCode, MergeTaskRequest, TaskMergeOutcome, TaskMergeResult } from './GitMergeIntegration.js';
