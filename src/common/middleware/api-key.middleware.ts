import { timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  type NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { EnvConfig } from '../../config/env.validation';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Enforces the `X-API-Key` header against `API_KEY` on all protected routes.
 */
@Injectable()
export class ApiKeyMiddleware implements NestMiddleware {
  private readonly expectedApiKey: string;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    this.expectedApiKey = this.configService.get('API_KEY', { infer: true });
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    // Allow browser CORS preflight requests without requiring an API key.
    if (req.method?.toUpperCase() === 'OPTIONS') {
      next();
      return;
    }

    const provided = req.headers['x-api-key'];
    if (
      typeof provided !== 'string' ||
      !safeEqual(provided, this.expectedApiKey)
    ) {
      throw new UnauthorizedException('unauthorized');
    }
    next();
  }
}
