export type SurfaceGuardErrorCode =
  | 'SG_CONFIG_INVALID'
  | 'SG_ROOT_INVALID'
  | 'SG_RESOURCE_LIMIT'
  | 'SG_ABORTED'
  | 'SG_IO_ERROR';

export class SurfaceGuardError extends Error {
  public readonly code: SurfaceGuardErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: SurfaceGuardErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SurfaceGuardError';
    this.code = code;
    this.details = details;
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
