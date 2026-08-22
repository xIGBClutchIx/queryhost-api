export type LogValue = boolean | number | string | null;
export interface LogFields {
  readonly [key: string]: LogValue;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

type LogWriter = (line: string) => void;
type Timestamp = () => string;

/** Emits one bounded machine-readable JSON object per operational event. */
export class JsonLogger implements Logger {
  readonly #writeInfo: LogWriter;
  readonly #writeError: LogWriter;
  readonly #timestamp: Timestamp;

  public constructor(
    writeInfo: LogWriter = (line) => process.stdout.write(line),
    writeError: LogWriter = (line) => process.stderr.write(line),
    timestamp: Timestamp = () => new Date().toISOString(),
  ) {
    this.#writeInfo = writeInfo;
    this.#writeError = writeError;
    this.#timestamp = timestamp;
  }

  public info(event: string, fields: LogFields = {}): void {
    this.#writeInfo(this.#line("info", event, fields));
  }

  public error(event: string, fields: LogFields = {}): void {
    this.#writeError(this.#line("error", event, fields));
  }

  #line(level: "error" | "info", event: string, fields: LogFields): string {
    return `${JSON.stringify({ timestamp: this.#timestamp(), level, event, ...fields })}\n`;
  }
}
