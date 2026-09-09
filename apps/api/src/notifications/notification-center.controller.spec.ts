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
import {
  testDataSourceOptions,
  truncateAll,
} from '../test-support/test-database'
import { testUuid } from '../test-support/test-ids'
import { seedHolidayCalendar } from '../test-support/holiday-calendars'
import { LeaveDomainModule } from '../domain/leave-domain.module'
import { LeaveDomainService } from '../domain/leave-domain.service'
import { NotificationCenterController } from './notification-center.controller'
import { NotificationListenerService } from './notification-listener.service'

interface TestRequest {
  header(name: string): string | undefined
  user?: { id: string; email: string; name?: string; roles: string[] }
}

// Only the domain module plus this controller: the Notification Center needs no
// other wiring, which is itself worth pinning.
@Module({
  imports: [TypeOrmModule.forRoot(testDataSourceOptions), LeaveDomainModule],
  controllers: [NotificationCenterController],
  providers: [NotificationListenerService],
})
class TestNotificationAppModule {}

describe('Notification Center endpoints', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>
  let dataSource: DataSource
  let leaveDomain: LeaveDomainService
  let baseUrl: string

  beforeAll(async () => {
    app = await NestFactory.create(TestNotificationAppModule, { logger: false })
    // Stands in for the auth-oidc module's cookie middleware, which is what
    // populates req.user on every route in production.
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
    const address = app.getHttpServer().address() as { port: number }
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  const lead = { id: testUuid('lead-1'), email: 'lead@example.com' }
  const other = { id: testUuid('other-1'), email: 'other@example.com' }

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
    for (const [key, person] of [
      ['emp-1', { id: testUuid('emp-1'), email: 'emp@example.com' }],
      ['lead-1', lead],
      ['other-1', other],
    ] as const) {
      await leaveDomain.upsertUser({
        userId: person.id,
        email: person.email,
        displayName: key,
        countryCode: 'UA',
        employmentStartDate: '2026-01-01',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    }
    await leaveDomain.submitLeaveRequest({
      requesterUserId: testUuid('emp-1'),
      leaveType: LeaveType.Vacation,
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      approverEmails: [lead.email],
      ccEmails: [],
      submittedAt: '2026-01-02T09:00:00.000Z',
    })
  })

  const as = (person: { id: string; email: string }) => ({
    'x-user-id': person.id,
    'x-user-email': person.email,
  })

  it('serves only the caller their own notifications', async () => {
    const mine = await fetch(`${baseUrl}/notifications`, { headers: as(lead) })
    expect(mine.status).toBe(200)
    await expect(mine.json()).resolves.toMatchObject({
      unreadCount: 1,
      openAskCount: 1,
      items: [{ type: NotificationType.ApprovalNeeded }],
    })

    // Same request, different signed-in user: the feed is empty. Nothing in the
    // URL selects a recipient, so this cannot be widened by a client.
    const theirs = await fetch(`${baseUrl}/notifications`, { headers: as(other) })
    await expect(theirs.json()).resolves.toMatchObject({
      unreadCount: 0,
      openAskCount: 0,
      items: [],
    })
  })

  it('refuses an unauthenticated caller instead of serving somebody a feed', async () => {
    const anonymous = await fetch(`${baseUrl}/notifications`)
    expect(anonymous.status).toBe(401)
  })

  it('marks read and returns the fresh snapshot, and ignores another user\'s id', async () => {
    const listed = (await (
      await fetch(`${baseUrl}/notifications`, { headers: as(lead) })
    ).json()) as { items: Array<{ notificationId: string }> }
    const id = listed.items[0]?.notificationId as string

    // Someone else's id must match nothing rather than mark it read: the id in
    // the path never confers access.
    const foreign = await fetch(`${baseUrl}/notifications/${id}/read`, {
      method: 'POST',
      headers: as(other),
    })
    expect(foreign.status).toBe(201)
    const stillUnread = await fetch(`${baseUrl}/notifications`, {
      headers: as(lead),
    })
    await expect(stillUnread.json()).resolves.toMatchObject({ unreadCount: 1 })

    const mine = await fetch(`${baseUrl}/notifications/${id}/read`, {
      method: 'POST',
      headers: as(lead),
    })
    expect(mine.status).toBe(201)
    // The response IS the fresh snapshot, so the client needs no second call.
    await expect(mine.json()).resolves.toMatchObject({ unreadCount: 0 })
  })

  it('clears the whole feed on read-all without colliding with the per-id route', async () => {
    const response = await fetch(`${baseUrl}/notifications/read-all`, {
      method: 'POST',
      headers: as(lead),
    })
    expect(response.status).toBe(201)
    // Reading is not deciding: read-all clears the unread count while the
    // still-open ask keeps the bell's work indicator lit.
    await expect(response.json()).resolves.toMatchObject({
      unreadCount: 0,
      openAskCount: 1,
    })
  })
})
