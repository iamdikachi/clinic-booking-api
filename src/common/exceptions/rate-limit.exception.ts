import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * HTTP 429 exception that includes a `Retry-After` header in seconds.
 */
export class RateLimitException extends HttpException {
  readonly headers: Record<string, string>;

  constructor(retryAfterSeconds: number, message = 'rate limit exceeded') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
    this.headers = {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    };
  }
}
