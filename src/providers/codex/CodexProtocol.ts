export type CodexRequestId = string | number;

export interface CodexRequest {
  jsonrpc?: '2.0';
  id: CodexRequestId;
  method: string;
  params?: unknown;
}

export interface CodexResponse {
  jsonrpc?: '2.0';
  id: CodexRequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export type CodexServerRequest = CodexRequest;

export type CodexInboundMessage = CodexResponse | CodexNotification | CodexServerRequest;

export function classifyCodexMessage(value: unknown): CodexInboundMessage {
  if (!isRecord(value) || (value.jsonrpc !== undefined && value.jsonrpc !== '2.0')) throw new TypeError('Invalid JSON-RPC message');
  if (typeof value.method === 'string') {
    if ('id' in value && isRequestId(value.id)) return value as unknown as CodexServerRequest;
    return value as unknown as CodexNotification;
  }
  if ('id' in value && isRequestId(value.id) && ('result' in value || 'error' in value)) {
    return value as unknown as CodexResponse;
  }
  throw new TypeError('Unknown JSON-RPC message shape');
}

export function isCodexResponse(message: CodexInboundMessage): message is CodexResponse {
  return 'id' in message && !('method' in message);
}

export function isCodexNotification(message: CodexInboundMessage): message is CodexNotification {
  return 'method' in message && !('id' in message);
}

export function isCodexServerRequest(message: CodexInboundMessage): message is CodexServerRequest {
  return 'method' in message && 'id' in message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
