/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import 'reflect-metadata'
// Load .env files into process.env before AppModule is evaluated (its module
// decorators read process.env). This import must stay above './app.module'.
import './load-env'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module'
import { resolveTrustProxy } from './host/trust-proxy'

async function bootstrap() {
  // rawBody keeps the original request bytes on req.rawBody for @RawBody().
  // Trusted modules verify webhook signatures against those exact bytes
  // (e.g. Stripe); without the flag every delivery fails verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  })

  // nginx terminates TLS and reaches this process over plain HTTP, so Express
  // has to be told which peers may be believed about X-Forwarded-Proto.
  // Without it req.secure stays false, express-session drops the Secure
  // `auth-oidc.sid` cookie without logging anything, and every OIDC callback
  // fails with "checks.state argument is missing". Read host/trust-proxy.ts
  // before removing this.
  const trustProxy = resolveTrustProxy(process.env)
  if (trustProxy !== null) {
    app.set('trust proxy', trustProxy)
  } else if (process.env['NODE_ENV'] === 'production') {
    console.warn(
      'trust proxy is disabled while NODE_ENV=production: behind a ' +
        'TLS-terminating proxy express-session will drop the session cookie ' +
        'and OIDC login will fail',
    )
  }

  // On SIGTERM, lets NotificationListenerService close its dedicated LISTEN
  // connection and end every open SSE stream. Without it the per-stream
  // heartbeat timers keep the event loop alive and the container is killed
  // rather than shut down.
  app.enableShutdownHooks()
  const port = Number(process.env['PORT'] ?? 3000)
  const host = process.env['HOST'] ?? 'localhost'
  const basePath = process.env['BASE_PATH'] ?? ''

  const config = new DocumentBuilder()
    .setTitle('API')
    .setVersion('1.0')
    .addServer(basePath || '/')
    .build()
  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('api-docs', app, document)

  await app.listen(port, host)
  // The trust proxy value is in the line because express-session reports a
  // dropped cookie only through debug(), which is silent in production. This
  // makes the setting observable without attaching to the container.
  console.log(
    `API running on ${host}:${port} (trust proxy: ${trustProxy ?? 'off'})`,
  )
}

bootstrap()
