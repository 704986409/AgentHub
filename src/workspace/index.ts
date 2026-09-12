export * from './GitCommandRunner.js';
export * from './GitWorktreeManager.js';
export * from './TaskCommandRunner.js';
export { BuildTestEvidenceError } from './BuildTestEvidenceCollector.js';
export type { EvidenceCommandPhase, EvidenceCommandSpec, BuildTestEvidencePlan,
  CommandEvidence, BuildTestEvidence } from './BuildTestEvidenceCollector.js';
export { GitChangeCaptureError, canonicalTrackedIdentity } from './GitWorkspaceChangeCapture.js';
export type { CaptureWorkspaceChangesOptions, GitChangeCaptureErrorCode, GitWorkingFileFingerprint,
  GitTrackedChange, CanonicalTrackedIdentity, GitPatchCapture, GitChangeLayer, GitStatusEntry,
  GitWorkspaceChangeSnapshot,
} from './GitWorkspaceChangeCapture.js';
