/**
 * Errors carry an HTTP status, a stable machine code, and — importantly for
 * this product — a message that a non-technical user can act on. The API
 * error handler serialises exactly these three fields; stack traces never
 * cross the wire.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Optional next step shown under the error in the UI. */
  readonly hint?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, hint: this.hint, details: this.details },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, { details });

export const unauthorized = (message = 'You need to sign in to do that.') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = "You don't have permission to do that.") =>
  new AppError(403, 'forbidden', message);

export const notFound = (what = 'That') => new AppError(404, 'not_found', `${what} was not found.`);

export const conflict = (message: string, hint?: string) =>
  new AppError(409, 'conflict', message, { hint });

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, { details });

export const tooManyRequests = (message = 'Too many requests. Slow down a moment.') =>
  new AppError(429, 'rate_limited', message);

export const internal = (message = 'Something went wrong on our side.', cause?: unknown) =>
  new AppError(500, 'internal_error', message, { cause });

export const upstreamFailure = (service: string, cause?: unknown) =>
  new AppError(502, 'upstream_failure', `Couldn't reach ${service}. Try again in a moment.`, {
    cause,
    hint: 'This is usually temporary and outside your server — no action needed on your side.',
  });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
