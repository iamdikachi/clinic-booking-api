import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('General')
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
