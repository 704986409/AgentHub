export type ApiErrorCode =
  | 'AGENTHUB_API_INVALID_REQUEST'
  | 'AGENTHUB_API_NOT_FOUND'
  | 'AGENTHUB_API_METHOD_NOT_ALLOWED'
  | 'AGENTHUB_API_CONTENT_TYPE_REQUIRED'
  | 'AGENTHUB_API_BODY_TOO_LARGE'
  | 'AGENTHUB_API_IDEMPOTENCY_KEY_REQUIRED'
  | 'AGENTHUB_API_IDEMPOTENCY_CONFLICT'
  | 'AGENTHUB_API_IDEMPOTENCY_CAPACITY'
  | 'AGENTHUB_API_REVIEW_HANDLE_EXPIRED'
  | 'AGENTHUB_API_CONFLICT'
  | 'AGENTHUB_API_LIFECYCLE_DENIED'
  | 'AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED'
  | 'AGENTHUB_API_INTERNAL';

export class ApiError extends Error {
  public constructor(public readonly code: ApiErrorCode, public readonly status: number) {
    super(safeApiMessage(code));
    this.name = 'ApiError';
  }
}

export function apiError(code: ApiErrorCode, status: number): ApiError {
  return new ApiError(code, status);
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (code.includes('RUNTIME_RECONCILIATION')) {
    return apiError('AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED', 503);
  }
  if (code.includes('BUSY') || code.includes('STALE') || code.includes('CONFLICT') ||
    code.includes('OWNERSHIP') || code.includes('ALREADY')) return apiError('AGENTHUB_API_CONFLICT', 409);
  if (code.includes('GATE_DENIED') || code.includes('MERGE_DENIED') || code.includes('REVISION_FAILED') ||
    code.includes('EVIDENCE')) return apiError('AGENTHUB_API_LIFECYCLE_DENIED', 422);
  if (code.includes('INVALID') || code.includes('NOT_SCHEDULABLE')) {
    return apiError('AGENTHUB_API_INVALID_REQUEST', 400);
  }
  if (code.includes('NOT_FOUND')) return apiError('AGENTHUB_API_NOT_FOUND', 404);
  return apiError('AGENTHUB_API_INTERNAL', 500);
}

function safeApiMessage(code: ApiErrorCode): string {
  const messages: Record<ApiErrorCode, string> = {
    AGENTHUB_API_INVALID_REQUEST: 'Request is invalid',
    AGENTHUB_API_NOT_FOUND: 'Resource was not found',
    AGENTHUB_API_METHOD_NOT_ALLOWED: 'Method is not allowed',
    AGENTHUB_API_CONTENT_TYPE_REQUIRED: 'Content-Type application/json is required',
    AGENTHUB_API_BODY_TOO_LARGE: 'Request body is too large',
    AGENTHUB_API_IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key is required',
    AGENTHUB_API_IDEMPOTENCY_CONFLICT: 'Idempotency key conflicts with another request',
    AGENTHUB_API_IDEMPOTENCY_CAPACITY: 'Idempotency capacity is temporarily unavailable',
    AGENTHUB_API_REVIEW_HANDLE_EXPIRED: 'Review handle is unavailable or expired',
    AGENTHUB_API_CONFLICT: 'Request conflicts with current state',
    AGENTHUB_API_LIFECYCLE_DENIED: 'Lifecycle operation was denied',
    AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED: 'Runtime state requires reconciliation',
    AGENTHUB_API_INTERNAL: 'Internal server error',
  };
  return messages[code];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
