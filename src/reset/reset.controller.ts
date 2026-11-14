import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { API_KEY_SECURITY } from '../config/swagger.config';
import { ResetRequestDto, ResetResponseDto } from './dto/reset.dto';
import { ResetService } from './reset.service';

@ApiTags('Reset')
@ApiSecurity(API_KEY_SECURITY)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid X-API-Key header',
  type: ErrorResponseDto,
})
@Controller('reset')
export class ResetController {
  constructor(private readonly resetService: ResetService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset database state and seed slots',
    description:
      'Clears bookings, slots, idempotency_keys, and attempts in a transaction, then inserts the supplied slots (including past slots).',
  })
  @ApiBody({ type: ResetRequestDto, required: false })
  @ApiOkResponse({ type: ResetResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid slots payload',
    type: ErrorResponseDto,
  })
  reset(@Body() body: unknown): Promise<ResetResponseDto> {
    return this.resetService.reset(body);
  }
}
