export interface CodexSession {
  threadId: string;
  sessionId: string;
}

export interface CodexSessionRecord extends CodexSession {
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexSessionStore {
  get(sessionKey: string): CodexSessionRecord | undefined;
  save(sessionKey: string, session: CodexSession): CodexSessionRecord;
  delete(sessionKey: string): void;
}

export class CodexSessionStoreError extends Error {
  public constructor(
    public readonly code: 'INVALID_SESSION_KEY' | 'INVALID_THREAD_ID' | 'INVALID_SESSION_ID',
    message: string,
  ) {
    super(message);
    this.name = 'CodexSessionStoreError';
  }
}

export function normalizeSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new CodexSessionStoreError('INVALID_SESSION_KEY', 'sessionKey must contain 1 to 256 characters');
  }
  return normalized;
}

export function validateCodexSession(session: CodexSession): CodexSession {
  const threadId = session.threadId.trim();
  const sessionId = session.sessionId.trim();
  if (threadId.length === 0) throw new CodexSessionStoreError('INVALID_THREAD_ID', 'threadId must not be empty');
  if (sessionId.length === 0) throw new CodexSessionStoreError('INVALID_SESSION_ID', 'sessionId must not be empty');
  return { threadId, sessionId };
}
