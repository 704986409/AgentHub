export * from './GitCommandRunner.js';
export * from './GitWorktreeManager.js';
export { GitChangeCaptureError, canonicalTrackedIdentity } from './GitWorkspaceChangeCapture.js';
export type { CaptureWorkspaceChangesOptions, GitChangeCaptureErrorCode, GitWorkingFileFingerprint,
  GitTrackedChange, CanonicalTrackedIdentity, GitPatchCapture, GitChangeLayer, GitStatusEntry,
  GitWorkspaceChangeSnapshot,
} from './GitWorkspaceChangeCapture.js';
