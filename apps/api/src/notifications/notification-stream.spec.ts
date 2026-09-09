/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { LeaveType, NotificationType } from '@workspace/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataSource } from 'typeorm'
import { firstValueFrom, filter, take } from 'rxjs'
import {
  testDataSourceOptions,
  truncateAll,
} from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { NotificationService } from '../domain/notification.service'
import { NotificationCenterController } from './notification-center.controller'
import { NotificationListenerService } from './notification-listener.service'

interface TestRequest {
  header(name: string): string | undefined
  user?: { id: string; email: string; roles: string[] }
}

@Module({
  imports: [TypeOrmModule.forRoot(testDataSourceOptions), LeaveDomainModule],
  controllers: [NotificationCenterController],
  providers: [NotificationListenerService],
})
class TestStreamAppModule {}

// The realtime path. Everything here needs a real Postgres: the guarantee being
// tested IS a Postgres guarantee (NOTIFY is withheld until COMMIT).
describe('notification stream', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>
  let dataSource: DataSource
  let leaveDomain: LeaveDomainService
  let notifications: NotificationService
  let listener: NotificationListenerService
  let baseUrl: string

  const employee = { id: testUuid('emp-1'), email: 'emp@example.com' }
  const lead = { id: testUuid('lead-1'), email: 'lead@example.com' }
  const other = { id: testUuid('other-1'), email: 'other@example.com' }

  beforeAll(async () => {
    app = await NestFactory.create(TestStreamAppModule, { logger: false })
    app.use((req: TestRequest, _res: unknown, next: () => void) => {
      const userId = req.header('x-user-id')
      const email = req.header('x-user-email')
      if (userId && email) {
        req.user = { id: userId, email, roles: [] }
      }
      next()
    })
    await app.listen(0)

    dataSource = app.get(DataSource)
    leaveDomain = app.get(LeaveDomainService)
    notifications = app.get(NotificationService)
    listener = app.get(NotificationListenerService)
    const address = app.getHttpServer().address() as { port: number }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    // If this hangs or the process does not exit, the dedicated LISTEN client
    // leaked or a stream's heartbeat outlived shutdown. That failure IS the
    // assertion.
    await app.close()
  })

  beforeEach(async () => {
    await truncateAll(dataSource)
    await leaveDomain.updateLeaveSettings({
      defaultVacationDays: 24,
      defaultSickDays: 12,
      defaultApproverEmails: [],
      defaultCcApproverEmails: [],
      countries: [{ code: 'UA', name: 'Ukraine' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await seedHolidayCalendar(leaveDomain)
    for (const person of [employee, lead, other]) {
      await leaveDomain.upsertUser({
        userId: person.id,
        email: person.email,
        displayName: person.email,
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
  })

  // The stream opens with a hello and then heartbeats; only 'notification'
  // frames matter to these assertions.
  const nextNotification = (userId: string) =>
    firstValueFrom(
      listener.streamFor(userId).pipe(
        filter((event) => event.type === 'notification'),
        take(1),
      ),
    )

  const submitToLead = (day = '2026-01-05') =>
    leaveDomain.submitLeaveRequest({
      requesterUserId: employee.id,
      leaveType: LeaveType.Vacation,
      startDate: day,
      endDate: day,
      approverEmails: [lead.email],
      ccEmails: [],
      submittedAt: '2026-01-02T09:00:00.000Z',
    })

  it('delivers a signal for a real submission to the approver it concerns', async () => {
    const received = nextNotification(lead.id)
    await submitToLead()
    await expect(received).resolves.toMatchObject({ type: 'notification' })
  })

  it('withholds delivery until the transaction commits', async () => {
    // THE assertion that justifies routing the signal through Postgres at all.
    // An in-process bus would push on record() and the client would refetch a
    // snapshot that does not contain the row yet.
    //
    // Addressed to `other`, who is nobody's approver: the request below commits
    // its own transaction, and a signal from THAT would be indistinguishable
    // from the one under test if they shared a recipient.
    const request = await submitToLead('2026-01-07')

    let delivered = false
    const subscription = listener
      .streamFor(other.id)
      .pipe(filter((event) => event.type === 'notification'))
      .subscribe(() => {
        delivered = true
      })

    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const transaction = dataSource.transaction(async (manager) => {
      await notifications.record(manager, {
        recipientUserId: other.id,
        actorUserId: employee.id,
        actorLabel: 'Employee',
        type: NotificationType.ApprovalNeeded,
        requestId: request.requestId,
        occurredAt: '2026-01-02T09:00:00.000Z',
        summary: 'held until commit',
      })
      await held
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      // Written, announced, but NOT committed: Postgres must be sitting on it.
      expect(delivered).toBe(false)
    } finally {
      // Always release: an open transaction holds locks that would hang the next
      // test's truncateAll rather than fail it.
      release()
      await transaction
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(delivered).toBe(true)
    subscription.unsubscribe()
  })

  it('keeps one user\'s signals out of another user\'s stream', async () => {
    // The security assertion: the recipient filter is the only thing between two
    // users' streams, and the id it filters on comes from the session.
    let leaked = false
    const subscription = listener
      .streamFor(other.id)
      .pipe(filter((event) => event.type === 'notification'))
      .subscribe(() => {
        leaked = true
      })

    const received = nextNotification(lead.id)
    await submitToLead()
    await received
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(leaked).toBe(false)
    subscription.unsubscribe()
  })

  it('opens the stream with a hello so the client learns it is connected', async () => {
    // Nest defers the response headers until the first message, so without the
    // hello EventSource.onopen would not fire until the first real notification.
    const first = await firstValueFrom(listener.streamFor(lead.id))
    expect(first).toMatchObject({ type: 'hello' })
    // Pins the browser's reconnect delay from the server side.
    expect(first.retry).toBe(3_000)
  })

  it('refuses an unauthenticated stream with JSON, not a hanging event-stream', async () => {
    // This is what justifies handling identity in the handler rather than with a
    // guard: the 401 must land before the SSE headers are committed.
    const response = await fetch(`${baseUrl}/notifications/stream`)
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    await response.body?.cancel()
  })
})
