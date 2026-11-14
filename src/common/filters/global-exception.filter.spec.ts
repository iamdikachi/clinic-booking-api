import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter', () => {
  let reply: jest.Mock;
  let setHeader: jest.Mock;
  let isHeadersSent: jest.Mock;
  let filter: GlobalExceptionFilter;
  let mockResponse: object;

  const createHost = (type: 'http' | 'rpc' = 'http'): ArgumentsHost =>
    ({
      getType: () => type,
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => ({}),
        getNext: () => undefined,
      }),
    }) as unknown as ArgumentsHost;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    reply = jest.fn();
    setHeader = jest.fn();
    isHeadersSent = jest.fn().mockReturnValue(false);
    mockResponse = {};

    const httpAdapterHost = {
      httpAdapter: {
        reply,
        setHeader,
        isHeadersSent,
      },
    } as unknown as HttpAdapterHost;

    filter = new GlobalExceptionFilter(httpAdapterHost);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('formats BadRequestException with string message as { error }', () => {
    filter.catch(new BadRequestException('invalid email'), createHost());
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'invalid email' },
      HttpStatus.BAD_REQUEST,
    );
  });

  it('joins array messages from validation errors', () => {
    filter.catch(
      new BadRequestException(['name is required', 'email is invalid']),
      createHost(),
    );
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'name is required; email is invalid' },
      HttpStatus.BAD_REQUEST,
    );
  });

  it('formats NotFoundException as { error }', () => {
    filter.catch(new NotFoundException('slot not found'), createHost());
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'slot not found' },
      HttpStatus.NOT_FOUND,
    );
  });

  it('supports plain { error } HttpException payloads and custom headers', () => {
    const exc = Object.assign(
      new HttpException({ error: 'too many requests' }, 429),
      { headers: { 'Retry-After': 42 } },
    );
    filter.catch(exc, createHost());
    expect(setHeader).toHaveBeenCalledWith(mockResponse, 'Retry-After', '42');
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'too many requests' },
      429,
    );
  });

  it('handles Express http-error-like objects (e.g. body parser 400)', () => {
    const parseErr = Object.assign(new SyntaxError('Unexpected token'), {
      statusCode: 400,
    });
    filter.catch(parseErr, createHost());
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'Unexpected token' },
      400,
    );
  });

  it('returns 500 internal server error without leaking details on unknown errors', () => {
    filter.catch(new Error('secret SQL failure'), createHost());
    expect(reply).toHaveBeenCalledWith(
      mockResponse,
      { error: 'internal server error' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });

  it('does nothing if headers were already sent or context is non-http', () => {
    filter.catch(new BadRequestException('ignored'), createHost('rpc'));
    expect(reply).not.toHaveBeenCalled();

    isHeadersSent.mockReturnValue(true);
    filter.catch(new BadRequestException('ignored'), createHost('http'));
    expect(reply).not.toHaveBeenCalled();
  });
});
