import { StringDecoder } from 'node:string_decoder';

export type ClaudeRawMessage = Record<string, unknown>;

export type ClaudeJsonlParseErrorCode =
  | 'CLAUDE_JSONL_INVALID_JSON'
  | 'CLAUDE_JSONL_INVALID_ROOT'
  | 'CLAUDE_JSONL_LINE_TOO_LARGE'
  | 'CLAUDE_JSONL_PARSER_CLOSED'
  | 'CLAUDE_JSONL_PARSER_FAILED';

export class ClaudeJsonlParseError extends Error {
  public constructor(
    public readonly code: ClaudeJsonlParseErrorCode,
    message: string,
    public readonly lineNumber: number,
    public readonly lineByteLength: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClaudeJsonlParseError';
  }
}

export interface ClaudeJsonlParserOptions {
  onMessage: (message: ClaudeRawMessage) => void;
  onError: (error: ClaudeJsonlParseError) => void;
  maxLineBytes?: number;
}

export class ClaudeJsonlParser {
  readonly #decoder = new StringDecoder('utf8');
  readonly #onMessage: (message: ClaudeRawMessage) => void;
  readonly #onError: (error: ClaudeJsonlParseError) => void;
  readonly #maxLineBytes: number;
  #buffer = '';
  #lineNumber = 0;
  #ended = false;
  #failed = false;

  public constructor(options: ClaudeJsonlParserOptions) {
    this.#onMessage = options.onMessage;
    this.#onError = options.onError;
    this.#maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes <= 0) {
      throw new RangeError('maxLineBytes must be a positive safe integer');
    }
  }

  public get closed(): boolean {
    return this.#ended;
  }

  public get failed(): boolean {
    return this.#failed;
  }

  public get lineNumber(): number {
    return this.#lineNumber;
  }

  public push(chunk: Buffer): void {
    if (this.#failed) {
      throw new ClaudeJsonlParseError(
        'CLAUDE_JSONL_PARSER_FAILED',
        'Claude JSONL parser is in a terminal failed state',
        this.#lineNumber,
        0,
      );
    }
    if (this.#ended) {
      throw new ClaudeJsonlParseError(
        'CLAUDE_JSONL_PARSER_CLOSED',
        'Claude JSONL parser is closed',
        this.#lineNumber,
        0,
      );
    }
    this.#buffer += this.#decoder.write(chunk);
    this.processCompleteLines();
    this.enforceLineLimit(this.#buffer, this.#lineNumber + 1);
  }

  public end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#failed) return;
    this.#buffer += this.#decoder.end();
    this.processCompleteLines();
    if (this.#buffer.length === 0) return;
    this.#lineNumber += 1;
    const finalLine = this.#buffer;
    this.#buffer = '';
    this.parseLine(finalLine, this.#lineNumber);
  }

  private processCompleteLines(): void {
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0 && !this.#failed) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#lineNumber += 1;
      this.parseLine(line.endsWith('\r') ? line.slice(0, -1) : line, this.#lineNumber);
      newline = this.#buffer.indexOf('\n');
    }
  }

  private parseLine(line: string, lineNumber: number): void {
    const byteLength = Buffer.byteLength(line, 'utf8');
    if (!this.enforceLineLimit(line, lineNumber)) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (cause) {
      this.fail(new ClaudeJsonlParseError(
        'CLAUDE_JSONL_INVALID_JSON',
        `Invalid Claude JSONL at line ${String(lineNumber)}`,
        lineNumber,
        byteLength,
        { cause },
      ));
      return;
    }
    if (!isRecord(value)) {
      this.fail(new ClaudeJsonlParseError(
        'CLAUDE_JSONL_INVALID_ROOT',
        `Claude JSONL line ${String(lineNumber)} must contain a JSON object`,
        lineNumber,
        byteLength,
      ));
      return;
    }
    this.#onMessage(value);
  }

  private enforceLineLimit(line: string, lineNumber: number): boolean {
    const byteLength = Buffer.byteLength(line, 'utf8');
    if (byteLength <= this.#maxLineBytes) return true;
    this.fail(new ClaudeJsonlParseError(
      'CLAUDE_JSONL_LINE_TOO_LARGE',
      `Claude JSONL line ${String(lineNumber)} exceeds ${String(this.#maxLineBytes)} bytes`,
      lineNumber,
      byteLength,
    ));
    return false;
  }

  private fail(error: ClaudeJsonlParseError): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#buffer = '';
    this.#onError(error);
  }
}

function isRecord(value: unknown): value is ClaudeRawMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
