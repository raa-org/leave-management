/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { Brackets, DataSource, type EntityManager } from 'typeorm'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import {
  AuditActionKind,
  AuditCategory,
  AuditEventType,
  type AdminAuditLogItemDto,
  type AdminAuditLogPageDto,
  type AdminAuditLogQueryDto,
  type AppRoleName,
  type AuditFieldChangeDto,
  type AuditStateSnapshot,
} from '@workspace/contracts'
import { AuditLogEntity } from './entities/audit-log.entity'
import { ClockService } from './clock.service'
import {
  clampLimit,
  decodeKeysetCursor,
  keysetWhere,
  takeKeysetPage,
} from './keyset-cursor'
import type { AuditActor } from './leave-domain.types'

// Static category + action-kind for every event type. Kept here (not on the
// call sites) so an event's classification is defined once.
const EVENT_META: Record<
  AuditEventType,
  { category: AuditCategory; action: AuditActionKind }
> = {
  [AuditEventType.UserLogin]: {
    category: AuditCategory.Auth,
    action: AuditActionKind.Login,
  },
  [AuditEventType.UserProvisioned]: {
    category: AuditCategory.Auth,
    action: AuditActionKind.Create,
  },
  [AuditEventType.UserProfileSynced]: {
    category: AuditCategory.Auth,
    action: AuditActionKind.Update,
  },
  [AuditEventType.UserRolesAssigned]: {
    category: AuditCategory.Role,
    action: AuditActionKind.Update,
  },
  [AuditEventType.UserLoginRefused]: {
    category: AuditCategory.Auth,
    action: AuditActionKind.Login,
  },
  [AuditEventType.UserDeactivated]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.UserReactivated]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.UserSyncConflict]: {
    // Only a sync pass can raise it, so it files under the run's own category
    // even though it names one employee.
    category: AuditCategory.LdapSync,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.UserIdentityConflict]: {
    // A refused sign-in, like user.login_refused: Auth + Login, no before/after
    // (nothing changed), so no field diff is derived.
    category: AuditCategory.Auth,
    action: AuditActionKind.Login,
  },
  [AuditEventType.LdapSyncCompleted]: {
    // Create: the run summary has no before-state; the UI shows only `after`
    // (the counters object).
    category: AuditCategory.LdapSync,
    action: AuditActionKind.Create,
  },
  [AuditEventType.LdapSyncFailed]: {
    // Same shape as the completed summary: no before-state, the failure
    // detail rides in the summary text.
    category: AuditCategory.LdapSync,
    action: AuditActionKind.Create,
  },
  [AuditEventType.EmployeeProfileUpdated]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.Update,
  },
  [AuditEventType.EmployeeAllocationUpdated]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.Update,
  },
  [AuditEventType.EmployeeBalanceAdjusted]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.Update,
  },
  [AuditEventType.EmployeeLeaveDataReset]: {
    category: AuditCategory.Employee,
    action: AuditActionKind.Delete,
  },
  [AuditEventType.LeaveRequestSubmitted]: {
    category: AuditCategory.LeaveRequest,
    action: AuditActionKind.Create,
  },
  [AuditEventType.LeaveRequestCancelled]: {
    category: AuditCategory.LeaveRequest,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestApproved]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestRejected]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestForceApproved]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestForceRejected]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestAutoApproved]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.LeaveRequestApproverRemoved]: {
    category: AuditCategory.Approval,
    action: AuditActionKind.Delete,
  },
  [AuditEventType.LeaveRequestModificationSubmitted]: {
    category: AuditCategory.LeaveRequest,
    action: AuditActionKind.Create,
  },
  [AuditEventType.LeaveRequestSuperseded]: {
    category: AuditCategory.LeaveRequest,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.PolicyCreated]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.Create,
  },
  [AuditEventType.PolicyUpdated]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.Update,
  },
  [AuditEventType.PolicySuperseded]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.PolicyDeleted]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.Delete,
  },
  [AuditEventType.PolicyDefaultChanged]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.PolicyMembershipAssigned]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.Create,
  },
  [AuditEventType.PolicyMembershipTransferred]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.PolicyMembershipTransferScheduled]: {
    // Create: a scheduled transfer has no before-state; the UI shows only
    // `after` (the future-dated membership row).
    category: AuditCategory.Policy,
    action: AuditActionKind.Create,
  },
  [AuditEventType.PolicyMembershipTransferScheduleCanceled]: {
    // Delete: cancelling removes the not-yet-effective row; only `before`.
    category: AuditCategory.Policy,
    action: AuditActionKind.Delete,
  },
  [AuditEventType.PolicyMembershipTransferBlocked]: {
    // A refusal, like ldap_sync.failed: no before-state changed, the blocking
    // detail rides in the summary/after payload.
    category: AuditCategory.Policy,
    action: AuditActionKind.Create,
  },
  [AuditEventType.PolicyMembershipBackdated]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.StateChange,
  },
  [AuditEventType.PolicyAllocationMaterialized]: {
    category: AuditCategory.Policy,
    action: AuditActionKind.Update,
  },
  [AuditEventType.ImportCompleted]: {
    // Create: a run summary has no before-state; the UI shows only `after`
    // (counters plus the employees the run touched).
    category: AuditCategory.Import,
    action: AuditActionKind.Create,
  },
  [AuditEventType.SettingsUpdated]: {
    category: AuditCategory.Settings,
    action: AuditActionKind.Update,
  },
  [AuditEventType.CountryCreated]: {
    category: AuditCategory.Country,
    action: AuditActionKind.Create,
  },
  [AuditEventType.CountryUpdated]: {
    category: AuditCategory.Country,
    action: AuditActionKind.Update,
  },
  [AuditEventType.CountryDeleted]: {
    category: AuditCategory.Country,
    action: AuditActionKind.Delete,
  },
  [AuditEventType.HolidayCalendarReplaced]: {
    category: AuditCategory.Holiday,
    action: AuditActionKind.Update,
  },
  [AuditEventType.HolidayCalendarCloned]: {
    category: AuditCategory.Holiday,
    action: AuditActionKind.Create,
  },
  [AuditEventType.HolidayCalendarDeleted]: {
    category: AuditCategory.Holiday,
    action: AuditActionKind.Delete,
  },
}

// Sentinel actor for automatic, non-user events.
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  label: 'System',
  email: null,
  roles: [],
}

// Actor stamped on every change the directory sync makes, so admins can tell
// sync-driven rows from human actions at a glance in the audit UI.
export const LDAP_SYNC_ACTOR: AuditActor = {
  userId: null,
  label: 'LDAP sync',
  email: null,
  roles: [],
}

// Build an audit actor from the authenticated request principal. Roles are
// captured verbatim (they include the per-login `administrator` grant that never
// reaches the DB).
export function toAuditActor(user: UserProfileType): AuditActor {
  return {
    userId: user.id,
    label: user.name ?? user.email,
    email: user.email,
    roles: user.roles as AppRoleName[],
  }
}

export interface RecordAuditInput {
  actor: AuditActor
  eventType: AuditEventType
  occurredAt?: string
  // The subject of the event. Omit for system-wide events (settings, holidays).
  target?: { userId: string | null; label?: string | null } | null
  entityType: string
  entityId?: string | null
  summary: string
  before?: AuditStateSnapshot | null
  after?: AuditStateSnapshot | null
  // Explicit diff; when omitted for an `update` event it is derived from
  // before/after. Pass an empty array to suppress the derived diff.
  changedFields?: AuditFieldChangeDto[] | null
  requestId?: string | null
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  private get manager(): EntityManager {
    return this.dataSource.manager
  }

  // Append one immutable audit row. Runs on the caller's transaction manager so
  // the audit entry commits atomically with the change it records.
  async record(manager: EntityManager, input: RecordAuditInput): Promise<void> {
    const meta = EVENT_META[input.eventType]
    // Derive the field-level diff for update / state-change events when the caller
    // did not supply one (pass an explicit [] to suppress it).
    const derivesDiff =
      meta.action === AuditActionKind.Update ||
      meta.action === AuditActionKind.StateChange
    const changedFields =
      input.changedFields === undefined && derivesDiff
        ? diffSnapshots(input.before ?? null, input.after ?? null)
        : (input.changedFields ?? null)

    const repo = manager.getRepository(AuditLogEntity)
    await repo.save(
      repo.create({
        id: randomUUID(),
        occurredAt: input.occurredAt ?? this.clock.nowIso(),
        eventType: input.eventType,
        category: meta.category,
        action: meta.action,
        actorUserId: input.actor.userId,
        actorLabel: input.actor.label,
        actorEmail: input.actor.email,
        actorRoles: input.actor.roles ?? [],
        targetUserId: input.target?.userId ?? null,
        targetLabel: input.target?.label ?? null,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        beforeState: input.before ?? null,
        afterState: input.after ?? null,
        changedFields: changedFields && changedFields.length > 0 ? changedFields : null,
        requestId: input.requestId ?? null,
      }),
    )
  }

  // Newest-first keyset pagination over the whole audit trail. Filters narrow by
  // the subject/actor user, category, event type, and an occurredAt range.
  async getAdminAuditLogs(
    query?: AdminAuditLogQueryDto,
  ): Promise<AdminAuditLogPageDto> {
    const limit = clampLimit(query?.limit)
    const qb = this.manager
      .getRepository(AuditLogEntity)
      .createQueryBuilder('audit')
      .orderBy('audit.occurredAt', 'DESC')
      .addOrderBy('audit.id', 'DESC')
      .take(limit + 1)

    if (query?.userId) {
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('audit.actorUserId = :userId', { userId: query.userId })
            .orWhere('audit.targetUserId = :userId', { userId: query.userId })
        }),
      )
    }
    if (query?.category) {
      qb.andWhere('audit.category = :category', { category: query.category })
    }
    if (query?.eventType) {
      qb.andWhere('audit.eventType = :eventType', { eventType: query.eventType })
    }
    if (query?.from) {
      qb.andWhere('audit.occurredAt >= :from', { from: query.from })
    }
    if (query?.to) {
      qb.andWhere('audit.occurredAt <= :to', { to: query.to })
    }

    const cursor = decodeKeysetCursor(query?.cursor)
    if (cursor) {
      // Keyset: rows strictly older than the cursor in (occurredAt, id) order.
      qb.andWhere(keysetWhere('audit', 'occurredAt'), {
        cursorSortValue: cursor.sortValue,
        cursorId: cursor.id,
      })
    }

    const rows = await qb.getMany()
    const { page, nextCursor } = takeKeysetPage(rows, limit, (last) => ({
      sortValue: last.occurredAt,
      id: last.id,
    }))

    return {
      items: page.map(toItemDto),
      nextCursor,
    }
  }
}

// Shallow field-level diff of two snapshots; values are compared structurally
// via JSON so arrays/objects (e.g. approver lists) register as changed.
function diffSnapshots(
  before: AuditStateSnapshot | null,
  after: AuditStateSnapshot | null,
): AuditFieldChangeDto[] {
  if (!before || !after) {
    return []
  }
  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: AuditFieldChangeDto[] = []
  for (const field of fields) {
    const a = before[field]
    const b = after[field]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field, before: a ?? null, after: b ?? null })
    }
  }
  return changes
}

function toItemDto(row: AuditLogEntity): AdminAuditLogItemDto {
  return {
    auditId: row.id,
    occurredAt: row.occurredAt,
    eventType: row.eventType,
    category: row.category,
    action: row.action,
    actorUserId: row.actorUserId ?? undefined,
    actorLabel: row.actorLabel,
    actorEmail: row.actorEmail ?? undefined,
    actorRoles: row.actorRoles ?? [],
    targetUserId: row.targetUserId ?? undefined,
    targetLabel: row.targetLabel ?? undefined,
    entityType: row.entityType,
    entityId: row.entityId ?? undefined,
    summary: row.summary,
    before: row.beforeState ?? undefined,
    after: row.afterState ?? undefined,
    changedFields: row.changedFields ?? undefined,
    requestId: row.requestId ?? undefined,
  }
}
