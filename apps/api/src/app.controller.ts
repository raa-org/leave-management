/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Controller, Get, Redirect } from '@nestjs/common'
import { ApiExcludeEndpoint } from '@nestjs/swagger'

// Captured at module load, i.e. process start; a few ms before app.listen.
const serverStartedAt = new Date()

@Controller()
export class AppController {
  @Get()
  @ApiExcludeEndpoint()
  @Redirect()
  root(): { url: string; statusCode: number } {
    return {
      url: `${process.env['BASE_PATH'] ?? ''}/api-docs`,
      statusCode: 302,
    }
  }

  @Get('health')
  health(): { status: string; startedAt: string } {
    return { status: 'ok', startedAt: serverStartedAt.toISOString() }
  }
}
