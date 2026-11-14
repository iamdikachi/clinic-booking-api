import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { EnvConfig } from './config/env.validation';
import { setupCors } from './config/cors.config';
import { setupSwagger } from './config/swagger.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  setupCors(app);
  setupSwagger(app);

  const configService = app.get(ConfigService<EnvConfig, true>);
  const port = configService.get('PORT', { infer: true });

  await app.listen(port);
}

void bootstrap();
