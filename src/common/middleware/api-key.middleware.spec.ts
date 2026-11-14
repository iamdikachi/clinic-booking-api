import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { EnvConfig } from '../../config/env.validation';
import { ApiKeyMiddleware } from './api-key.middleware';

describe('ApiKeyMiddleware', () => {
  let middleware: ApiKeyMiddleware;
  let next: jest.Mock<NextFunction>;
  const res = {} as Response;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue('expected-secret-key'),
    } as unknown as ConfigService<EnvConfig, true>;

    middleware = new ApiKeyMiddleware(configService);
    next = jest.fn();
  });

  it('calls next() when X-API-Key matches API_KEY', () => {
    const req = {
      headers: { 'x-api-key': 'expected-secret-key' },
    } as unknown as Request;

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('throws UnauthorizedException when X-API-Key is missing', () => {
    const req = { headers: {} } as unknown as Request;

    expect(() => middleware.use(req, res, next)).toThrow(UnauthorizedException);
    expect(() => middleware.use(req, res, next)).toThrow('unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when X-API-Key does not match (same or different length)', () => {
    const wrongSameLen = {
      headers: { 'x-api-key': 'expected-secret-kez' },
    } as unknown as Request;
    const wrongDiffLen = {
      headers: { 'x-api-key': 'short' },
    } as unknown as Request;

    expect(() => middleware.use(wrongSameLen, res, next)).toThrow(
      UnauthorizedException,
    );
    expect(() => middleware.use(wrongDiffLen, res, next)).toThrow(
      UnauthorizedException,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when X-API-Key is an array header', () => {
    const req = {
      headers: { 'x-api-key': ['expected-secret-key', 'other'] },
    } as unknown as Request;

    expect(() => middleware.use(req, res, next)).toThrow(UnauthorizedException);
    expect(next).not.toHaveBeenCalled();
  });
});
