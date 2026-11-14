import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { API_KEY_SECURITY } from '../config/swagger.config';
import { SlotsListResponseDto } from './dto/slot.dto';
import { SlotsService } from './slots.service';

@ApiTags('Slots')
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid X-API-Key header',
  type: ErrorResponseDto,
})
@Controller('slots')
export class SlotsController {
  constructor(private readonly slotsService: SlotsService) {}

  @Get()
  @ApiOperation({
    summary: 'List appointment slots ordered by start ascending',
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    type: String,
    description: 'Filter slots by provider identifier',
  })
  @ApiOkResponse({ type: SlotsListResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid query parameter',
    type: ErrorResponseDto,
  })
  findAll(
    @Query('provider') provider?: string | string[],
  ): Promise<SlotsListResponseDto> {
    return this.slotsService.findAll(provider);
  }
}
