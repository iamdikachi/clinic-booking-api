import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppService } from './app.service';
import { ErrorResponseDto } from './common/dto/error-response.dto';
import { API_KEY_SECURITY } from './config/swagger.config';

@ApiTags('General')
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid X-API-Key header',
  type: ErrorResponseDto,
})
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Root welcome message' })
  @ApiOkResponse({ type: String, description: 'Returns Hello World!' })
  getHello(): string {
    return this.appService.getHello();
  }
}
