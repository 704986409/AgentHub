import { classifyCodexMessage, type CodexInboundMessage } from './CodexProtocol.js';

export interface ParsedCodexMessage {
  message?: CodexInboundMessage;
  error?: Error;
}

export class CodexMessageParser {
  #buffer = '';

  public constructor(private readonly maxMessageBytes = 1_048_576) {}

  public feed(chunk: string | Buffer): ParsedCodexMessage[] {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parsed: ParsedCodexMessage[] = [];
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.maxMessageBytes && !this.#buffer.includes('\n')) {
      parsed.push({ error: new Error('JSONL message exceeds maximum size') });
      this.#buffer = '';
      return parsed;
    }
    let newlineIndex = this.#buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        if (Buffer.byteLength(line, 'utf8') > this.maxMessageBytes) {
          parsed.push({ error: new Error('JSONL message exceeds maximum size') });
        } else {
          try {
            parsed.push({ message: classifyCodexMessage(JSON.parse(line) as unknown) });
          } catch (error) {
            parsed.push({ error: error instanceof Error ? error : new Error(String(error)) });
          }
        }
      }
      newlineIndex = this.#buffer.indexOf('\n');
    }
    return parsed;
  }

  public end(): ParsedCodexMessage[] {
    if (this.#buffer.trim().length === 0) {
      this.#buffer = '';
      return [];
    }
    const remainder = this.#buffer;
    this.#buffer = '';
    return this.feed(`${remainder}\n`);
  }

  public reset(): void {
    this.#buffer = '';
  }
}
