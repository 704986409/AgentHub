export interface CursorParsedFrame {
  readonly type?: string;
  readonly sessionId?: string;
  readonly textDelta?: string;
  readonly isTerminal?: boolean;
  readonly raw: unknown;
}

export class CursorStreamParseError extends Error {
  public constructor(
    public readonly code:
      | 'CURSOR_LINE_OVERFLOW'
      | 'CURSOR_BUFFER_OVERFLOW'
      | 'CURSOR_PARSE_FAILED'
      | 'CURSOR_MALFORMED_JSON'
      | 'CURSOR_DUPLICATE_TERMINAL'
      | 'CURSOR_IDENTITY_CONFLICT'
      | 'CURSOR_IDENTITY_BLANK'
      | 'CURSOR_MISSING_TERMINAL',
    message: string,
  ) {
    super(message);
    this.name = 'CursorStreamParseError';
  }
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MiB

const TERMINAL_TYPES = new Set(['result', 'terminal', 'done', 'turn_complete']);

export class CursorStreamParser {
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;
  #buffer = '';
  #capturedSessionId: string | undefined;
  #accumulatedText = '';
  #terminalFound = false;
  #failed = false;

  public constructor(options: { maxLineBytes?: number; maxTotalBytes?: number } = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  public get capturedSessionId(): string | undefined {
    return this.#capturedSessionId;
  }

  public get accumulatedText(): string {
    return this.#accumulatedText;
  }

  public get isTerminal(): boolean {
    return this.#terminalFound;
  }

  public feed(chunk: string): void {
    this.#assertNotFailed();
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    this.#totalBytes += chunkBytes;
    if (this.#totalBytes > this.#maxTotalBytes) {
      this.#fail(
        new CursorStreamParseError(
          'CURSOR_BUFFER_OVERFLOW',
          `Cursor stream output exceeded maximum allowed size of ${String(this.#maxTotalBytes)} bytes`,
        ),
      );
    }

    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trimEnd();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(line, 'utf8') > this.#maxLineBytes) {
        this.#fail(
          new CursorStreamParseError(
            'CURSOR_LINE_OVERFLOW',
            `Cursor stream line exceeded limit of ${String(this.#maxLineBytes)} bytes`,
          ),
        );
      }

      if (line.trim().length > 0) {
        this.#processLine(line);
      }

      newlineIndex = this.#buffer.indexOf('\n');
    }

    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxLineBytes) {
      this.#fail(
        new CursorStreamParseError(
          'CURSOR_LINE_OVERFLOW',
          `Cursor stream line buffer exceeded limit of ${String(this.#maxLineBytes)} bytes`,
        ),
      );
    }
  }

  public finish(): { sessionId?: string; responseText: string } {
    this.#assertNotFailed();
    if (this.#buffer.trim().length > 0) {
      this.#processLine(this.#buffer.trim());
      this.#buffer = '';
    }

    if (!this.#terminalFound) {
      this.#fail(
        new CursorStreamParseError(
          'CURSOR_MISSING_TERMINAL',
          'Cursor stream completed without a terminal result frame',
        ),
      );
    }

    return {
      ...(this.#capturedSessionId !== undefined ? { sessionId: this.#capturedSessionId } : {}),
      responseText: this.#accumulatedText,
    };
  }

  #processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.#fail(
        new CursorStreamParseError(
          'CURSOR_MALFORMED_JSON',
          'Cursor stream-json stdout contained a malformed JSON frame',
        ),
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#fail(
        new CursorStreamParseError(
          'CURSOR_MALFORMED_JSON',
          'Cursor stream-json frame must be a JSON object',
        ),
      );
    }

    this.#handleParsedObject(parsed as Record<string, unknown>);
  }

  #handleParsedObject(obj: Record<string, unknown>): void {
    this.#observeIdentity(obj);

    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';

    if (TERMINAL_TYPES.has(type)) {
      if (this.#terminalFound) {
        this.#fail(
          new CursorStreamParseError(
            'CURSOR_DUPLICATE_TERMINAL',
            'Cursor stream contained more than one terminal result frame',
          ),
        );
      }
      this.#terminalFound = true;
      const text = obj.text ?? obj.content ?? obj.result ?? obj.response;
      if (typeof text === 'string') {
        if (!this.#accumulatedText.includes(text)) {
          if (this.#accumulatedText.length > 0) this.#accumulatedText += '\n';
          this.#accumulatedText += text;
        }
      }
      return;
    }

    const msg = typeof obj.message === 'object' && obj.message !== null ? (obj.message as Record<string, unknown>) : undefined;
    const content = obj.content ?? obj.text ?? obj.delta ?? msg?.content;
    if (typeof content === 'string' && content.length > 0) {
      if (this.#accumulatedText.length > 0 && !this.#accumulatedText.endsWith('\n') && !content.startsWith('\n')) {
        this.#accumulatedText += '\n';
      }
      this.#accumulatedText += content;
    }
  }

  #observeIdentity(obj: Record<string, unknown>): void {
    const sess = typeof obj.session === 'object' && obj.session !== null ? (obj.session as Record<string, unknown>) : undefined;
    const candidates: unknown[] = [obj.sessionId, obj.session_id, sess?.id];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      if (typeof candidate !== 'string') {
        this.#fail(
          new CursorStreamParseError(
            'CURSOR_IDENTITY_CONFLICT',
            'Cursor session identity must be a string',
          ),
        );
      }
      const id = candidate.trim();
      if (id.length === 0) {
        this.#fail(
          new CursorStreamParseError(
            'CURSOR_IDENTITY_BLANK',
            'Cursor session identity was blank',
          ),
        );
      }
      if (this.#capturedSessionId === undefined) {
        this.#capturedSessionId = id;
        continue;
      }
      if (this.#capturedSessionId !== id) {
        this.#fail(
          new CursorStreamParseError(
            'CURSOR_IDENTITY_CONFLICT',
            `Cursor session identity conflict: locked ${this.#capturedSessionId}, got ${id}`,
          ),
        );
      }
    }
  }

  #assertNotFailed(): void {
    if (this.#failed) {
      throw new CursorStreamParseError(
        'CURSOR_PARSE_FAILED',
        'Cursor stream parser is in a terminal failed state',
      );
    }
  }

  #fail(error: CursorStreamParseError): never {
    this.#failed = true;
    throw error;
  }
}
