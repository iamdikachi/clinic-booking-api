import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';

export const API_KEY_SECURITY = 'api-key';

/**
 * Configures and mounts OpenAPI JSON (`/docs-json`) and Swagger UI (`/docs`).
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Clinic Booking API')
    .setDescription('Clinic appointment slots and booking API')
    .setVersion('1.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
        description: 'API key passed in the X-API-Key request header',
      },
      API_KEY_SECURITY,
    )
    .build();

  const documentFactory = () =>
    SwaggerModule.createDocument(app, config, {
      extraModels: [ErrorResponseDto],
    });

  SwaggerModule.setup('docs', app, documentFactory, {
    customSiteTitle: 'Clinic Booking API Docs',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
