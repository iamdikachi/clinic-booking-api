import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

interface HttpErrorLike {
  statusCode?: number;
  status?: number;
  message?: string;
  headers?: Record<string, string | number>;
}

/**
 * Normalizes every HTTP and unexpected error into `{ error: "message" }`.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<unknown>();

    if (httpAdapter.isHeadersSent(response)) {
      return;
    }

    const { status, message, headers } = this.normalizeException(exception);

    if (status >= 500) {
      this.logger.error(
        `Unhandled error (${status}): ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        httpAdapter.setHeader(response, name, String(value));
      }
    }

    httpAdapter.reply(response, { error: message }, status);
  }

  private normalizeException(exception: unknown): {
    status: number;
    message: string;
    headers?: Record<string, string | number>;
  } {
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        message: this.extractHttpExceptionMessage(exception),
        headers: this.extractHeaders(exception),
      };
    }

    if (this.isHttpErrorLike(exception)) {
      const status = exception.statusCode ?? exception.status ?? 500;
      const message =
        status >= 500
          ? 'internal server error'
          : exception.message?.trim() || 'bad request';
      return {
        status,
        message,
        headers: this.extractHeaders(exception),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'internal server error',
    };
  }

  private extractHttpExceptionMessage(exception: HttpException): string {
    const res = exception.getResponse();

    if (typeof res === 'string') {
      return res.trim() || exception.message || 'request failed';
    }

    if (res && typeof res === 'object') {
      const body = res as Record<string, unknown>;
      if (typeof body.error === 'string' && body.message === undefined) {
        return body.error.trim() || exception.message || 'request failed';
      }
      if (typeof body.message === 'string') {
        return body.message.trim() || exception.message || 'request failed';
      }
      if (Array.isArray(body.message) && body.message.length > 0) {
        return body.message.map(String).join('; ');
      }
    }

    return exception.message || 'request failed';
  }

  private extractHeaders(
    exception: unknown,
  ): Record<string, string | number> | undefined {
    if (
      exception &&
      typeof exception === 'object' &&
      'headers' in exception &&
      exception.headers &&
      typeof exception.headers === 'object'
    ) {
      return exception.headers as Record<string, string | number>;
    }
    return undefined;
  }

  private isHttpErrorLike(exception: unknown): exception is HttpErrorLike {
    if (!exception || typeof exception !== 'object') {
      return false;
    }
    const candidate = exception as HttpErrorLike;
    const status = candidate.statusCode ?? candidate.status;
    return typeof status === 'number' && status >= 400 && status <= 599;
  }
}
