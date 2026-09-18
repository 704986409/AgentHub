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
      | 'CURSOR_PARSE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CursorStreamParseError';
  }
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MiB

export class CursorStreamParser {
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  #totalBytes = 0;
  #buffer = '';
  #capturedSessionId: string | undefined;
  #accumulatedText = '';
  #terminalFound = false;

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
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    this.#totalBytes += chunkBytes;
    if (this.#totalBytes > this.#maxTotalBytes) {
      throw new CursorStreamParseError(
        'CURSOR_BUFFER_OVERFLOW',
        `Cursor stream output exceeded maximum allowed size of ${String(this.#maxTotalBytes)} bytes`,
      );
    }

    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trimEnd();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(line, 'utf8') > this.#maxLineBytes) {
        throw new CursorStreamParseError(
          'CURSOR_LINE_OVERFLOW',
          `Cursor stream line exceeded limit of ${String(this.#maxLineBytes)} bytes`,
        );
      }

      if (line.trim().length > 0) {
        this.#processLine(line);
      }

      newlineIndex = this.#buffer.indexOf('\n');
    }

    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxLineBytes) {
      throw new CursorStreamParseError(
        'CURSOR_LINE_OVERFLOW',
        `Cursor stream line buffer exceeded limit of ${String(this.#maxLineBytes)} bytes`,
      );
    }
  }

  public finish(): { sessionId?: string; responseText: string } {
    if (this.#buffer.trim().length > 0) {
      this.#processLine(this.#buffer.trim());
      this.#buffer = '';
    }

    return {
      ...(this.#capturedSessionId !== undefined ? { sessionId: this.#capturedSessionId } : {}),
      responseText: this.#accumulatedText,
    };
  }

  #processLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        this.#handleParsedObject(parsed as Record<string, unknown>);
        return;
      }
    } catch {
      // Not JSON line: append to text if it looks like content
    }

    if (!line.startsWith('{') && !line.startsWith('[') && !line.startsWith('Warning:')) {
      if (this.#accumulatedText.length > 0) this.#accumulatedText += '\n';
      this.#accumulatedText += line;
    }
  }

  #handleParsedObject(obj: Record<string, unknown>): void {
    const sess = typeof obj.session === 'object' && obj.session !== null ? (obj.session as Record<string, unknown>) : undefined;
    const sid = obj.sessionId ?? obj.session_id ?? sess?.id;
    if (typeof sid === 'string' && sid.trim().length > 0) {
      this.#capturedSessionId = sid.trim();
    }

    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';

    if (type === 'result' || type === 'terminal' || type === 'done' || type === 'turn_complete') {
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

    // Text/content frames
    const msg = typeof obj.message === 'object' && obj.message !== null ? (obj.message as Record<string, unknown>) : undefined;
    const content = obj.content ?? obj.text ?? obj.delta ?? msg?.content;
    if (typeof content === 'string' && content.length > 0) {
      if (this.#accumulatedText.length > 0 && !this.#accumulatedText.endsWith('\n') && !content.startsWith('\n')) {
        this.#accumulatedText += '\n';
      }
      this.#accumulatedText += content;
    }
  }
}
