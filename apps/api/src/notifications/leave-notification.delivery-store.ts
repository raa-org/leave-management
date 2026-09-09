/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { NotificationDeliveryStatus } from '@workspace/contracts'
import { NotificationDeliveryEntity } from './notification-delivery.entity'

export type LeaveNotificationDeliveryStatus = NotificationDeliveryStatus

export interface LeaveNotificationDeliveryRecord {
  // Primary key of the journal row. The sender holds it from trackPending
  // onwards, which is what lets an outcome be written to the row it belongs to
  // instead of being matched back by a key two requests can share.
  deliveryId: string
  requestId: string
  subject: string
  to: string[]
  cc: string[]
  approvalUrl: string
  status: LeaveNotificationDeliveryStatus
  queuedAt: string
  updatedAt: string
  messageId?: string
  errorMessage?: string
}

@Injectable()
export class LeaveNotificationDeliveryStore {
  constructor(
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveries: Repository<NotificationDeliveryEntity>,
  ) {}

  async trackPending(input: {
    requestId: string
    subject: string
    to: string[]
    cc: string[]
    approvalUrl: string
    queuedAt: string
  }): Promise<LeaveNotificationDeliveryRecord> {
    const to = normalizeRecipients(input.to)
    const cc = normalizeRecipients(input.cc).filter(
      (recipient) => !to.includes(recipient),
    )
    const entity = this.deliveries.create({
      id: randomUUID(),
      requestId: input.requestId,
      subject: input.subject.trim(),
      to,
      cc,
      approvalUrl: input.approvalUrl,
      status: NotificationDeliveryStatus.Pending,
      queuedAt: input.queuedAt,
      updatedAt: input.queuedAt,
      messageId: null,
      errorMessage: null,
    })
    await this.deliveries.save(entity)
    return toPublicRecord(entity)
  }

  /**
   * Close out the row the caller queued, addressed by its primary key. The
   * send result is returned by the command that produced it, so the outcome
   * never has to be matched back to a row by subject and recipients — two
   * requests from one employee to one approver set look identical by those.
   */
  async markSentById(
    deliveryId: string,
    result: { messageId: string; accepted?: string[]; rejected?: string[] },
    occurredAt = new Date().toISOString(),
  ): Promise<LeaveNotificationDeliveryRecord | undefined> {
    const row = await this.deliveries.findOneBy({ id: deliveryId })
    if (!row) {
      return undefined
    }
    const accepted = normalizeRecipients(result.accepted ?? [])
    const rejected = normalizeRecipients(result.rejected ?? [])
    // A partly rejected send is not a clean success: the addresses the server
    // refused are named even though the accepted ones did get the mail. With
    // nothing accepted at all it is simply a failure wearing a message id.
    row.status =
      rejected.length > 0 && accepted.length === 0
        ? NotificationDeliveryStatus.Failed
        : NotificationDeliveryStatus.Sent
    row.messageId = result.messageId
    row.errorMessage =
      rejected.length > 0
        ? `Rejected by the mail server: ${rejected.join(', ')}`
        : null
    row.updatedAt = occurredAt
    await this.deliveries.save(row)
    return toPublicRecord(row)
  }

  async markFailedById(
    deliveryId: string,
    errorMessage: string,
    occurredAt = new Date().toISOString(),
  ): Promise<LeaveNotificationDeliveryRecord | undefined> {
    const row = await this.deliveries.findOneBy({ id: deliveryId })
    if (!row) {
      return undefined
    }
    row.status = NotificationDeliveryStatus.Failed
    row.errorMessage = errorMessage
    row.updatedAt = occurredAt
    await this.deliveries.save(row)
    return toPublicRecord(row)
  }

  async getLatestForRequest(
    requestId: string,
  ): Promise<LeaveNotificationDeliveryRecord | undefined> {
    const latest = await this.deliveries.findOne({
      where: { requestId },
      order: { createdAt: 'DESC', id: 'DESC' },
    })
    return latest ? toPublicRecord(latest) : undefined
  }

  async listForRequest(
    requestId: string,
  ): Promise<LeaveNotificationDeliveryRecord[]> {
    const rows = await this.deliveries.find({
      where: { requestId },
      order: { createdAt: 'ASC', id: 'ASC' },
    })
    return rows.map(toPublicRecord)
  }
}

function toPublicRecord(
  record: NotificationDeliveryEntity,
): LeaveNotificationDeliveryRecord {
  return {
    deliveryId: record.id,
    requestId: record.requestId ?? '',
    subject: record.subject,
    to: [...record.to],
    cc: [...record.cc],
    approvalUrl: record.approvalUrl ?? '',
    status: record.status,
    queuedAt: record.queuedAt,
    updatedAt: record.updatedAt,
    messageId: record.messageId ?? undefined,
    errorMessage: record.errorMessage ?? undefined,
  }
}

function normalizeRecipients(recipients: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const recipient of recipients) {
    const value = recipient.trim().toLowerCase()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}
