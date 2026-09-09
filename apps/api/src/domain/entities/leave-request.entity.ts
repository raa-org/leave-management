/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm'
import { LeaveRequestStatus, LeaveType } from '@workspace/contracts'
import {
  isoDateTimeTransformer,
  numericArrayTransformer,
} from '../../database/column-transformers'
import { dayColumn as day } from './day-column'
import { UserEntity } from './user.entity'

@Entity('leave_requests')
@Index('idx_leave_requests_requester', ['requesterUserId'])
@Index('idx_leave_requests_feed', ['lastActivityAt', 'id'])
@Index('idx_leave_requests_supersedes', ['supersedesRequestId'])
// One pending replacement per original, enforced in the database so two
// concurrent modification submits cannot both win the domain-level check.
@Index('uq_leave_requests_pending_supersede', ['supersedesRequestId'], {
  unique: true,
  where: `"status" = 'pending' AND "supersedesRequestId" IS NOT NULL`,
})
export class LeaveRequestEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string

  @Column({ type: 'uuid' })
  requesterUserId!: string

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requesterUserId' })
  requester?: UserEntity

  // Requester name is joined from users at read time (no snapshot).

  @Column({ type: 'enum', enum: LeaveType })
  leaveType!: LeaveType

  @Column({ type: 'enum', enum: LeaveRequestStatus })
  status!: LeaveRequestStatus

  // ANCHOR year (derived from startDate). A request may span the New Year;
  // funding is per day-year: holds, spends and releases each post against the
  // year the day falls in, so this column names the request without deciding
  // where its days charge.
  @Column({ type: 'int' })
  leaveYear!: number

  @Column({ type: 'date' })
  startDate!: string

  @Column({ type: 'date' })
  endDate!: string

  @Column(day)
  requestedDays!: number

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  submittedAt!: string

  // Denormalized snapshot of the NEWEST timeline activity (by occurredAt).
  // Two writers only: submitLeaveRequest seeds it at insert ('submitted' /
  // submittedAt) and LeaveDomainService.addActivity keeps it fresh in the same
  // transaction as every activity insert. Backs the admin activity feed
  // (ordering + display) without scanning leave_request_activities.
  @Column({ type: 'varchar' })
  lastAction!: string

  @Column({ type: 'timestamptz', transformer: isoDateTimeTransformer })
  lastActivityAt!: string

  @Column({ type: 'varchar', nullable: true })
  comment!: string | null

  @Column({ type: 'varchar', nullable: true })
  decisionComment!: string | null

  @Column({
    type: 'timestamptz',
    nullable: true,
    transformer: isoDateTimeTransformer,
  })
  decidedAt!: string | null

  // Internal reconciliation state (not part of any DTO). Holds and releases
  // cover the PAID days only, so this is the paid remainder, not the whole
  // request. An AMOUNT of leave, its dates priced by their portions: a request
  // of two half days still on the books holds one day, not two.
  @Column(day)
  remainingHeldDays!: number

  // Positional cursor over leaveDays, paid and unpaid alike: it answers "has
  // this leave started" for the cancel/modify guards, so unpaid days advance it
  // too even though they post nothing to the balance. A count of DATES, which
  // is what makes it the slice position over leaveDays, and what stops it being
  // interchangeable with requestedDays: that one says what those dates cost.
  @Column(day)
  spentDaysConsumed!: number

  // The concrete non-holiday days frozen at submit time.
  @Column({ type: 'text', array: true })
  leaveDays!: string[]

  // How much of each leaveDays entry the employee is actually away for, index
  // by index: [1, 0.5, 1] is a three-day request whose middle day is four hours
  // of an eight-hour day. Portions sit on the hour grid and are frozen with the
  // dates. EMPTY means every date is a full day, which is what every
  // pre-feature row is — the same "empty means the ordinary case" idiom
  // unpaidLeaveDays uses, and the reason neither needed a backfill.
  @Column({
    type: 'numeric',
    array: true,
    precision: 4,
    scale: 3,
    default: () => `'{}'`,
    transformer: numericArrayTransformer,
  })
  dayPortions!: number[]

  // The subset of leaveDays the projected balance could not fund, frozen at
  // submit alongside them. Unpaid days are never held, never spent and never
  // released. Not necessarily a trailing run: accrual arriving mid-request funds
  // the days after it, so an unpaid stretch can precede a paid one. Empty means
  // the whole request is paid, which is what every pre-feature row is.
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  unpaidLeaveDays!: string[]

  // Set on a REPLACEMENT: the approved request whose dates it proposes to
  // change. The original stays Approved (and keeps its hold) until every
  // approver has approved the replacement; that approval releases the
  // original's hold and flips it to Superseded in the same transaction.
  // RESTRICT: an original may not be deleted out from under its replacement.
  @Column({ type: 'uuid', nullable: true })
  supersedesRequestId!: string | null

  @ManyToOne(() => LeaveRequestEntity, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'supersedesRequestId' })
  supersedes?: LeaveRequestEntity | null
}
