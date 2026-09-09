import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Reorders every original table so the `id` primary key is the FIRST physical
 * column. Postgres cannot move a column in place, so each table is recreated
 * (rename -> create-with-id-first -> copy -> drop old) with its primary key,
 * unique constraints and indexes restored; all foreign keys are dropped up
 * front and re-added afterwards. Hand-written because migration:generate ignores
 * physical column order. Purely cosmetic: no column, type, default, constraint
 * or data changes - only ordinal position.
 */
export class ReorderPrimaryKeyColumnsFirst1783612600000
  implements MigrationInterface
{
  name = 'ReorderPrimaryKeyColumnsFirst1783612600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
-- 1. drop every foreign key so referenced tables can be recreated
ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_521adef4062ef84ff39490f1a91";
ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_fd077f9cfc97d4a6703027c5c5d";
ALTER TABLE "leave_allocations" DROP CONSTRAINT "FK_6b3bac3a86087b3e14434956685";
ALTER TABLE "leave_allocations" DROP CONSTRAINT "FK_a5fc48d6b3e7b39bbd2376a8aeb";
ALTER TABLE "leave_approval_decisions" DROP CONSTRAINT "FK_0bc4d920fb3de2730e1327b866d";
ALTER TABLE "leave_balance_changes" DROP CONSTRAINT "FK_1865db77a6240984d05e60211ae";
ALTER TABLE "leave_balances" DROP CONSTRAINT "FK_aae940169a5f4c5df2c79d0e080";
ALTER TABLE "leave_request_activities" DROP CONSTRAINT "FK_943e3073dded29faac709c55fbc";
ALTER TABLE "leave_request_approvers" DROP CONSTRAINT "FK_fe6a0fc72e4d6b4704f266cf408";
ALTER TABLE "leave_requests" DROP CONSTRAINT "FK_ccf03ef9ce51273f64eaef3e7ac";
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "FK_73495b72b8069ba0a85a0b45c13";
ALTER TABLE "user_project_memberships" DROP CONSTRAINT "FK_3678bdfa7f7d854c23cd084ae1b";
ALTER TABLE "user_project_memberships" DROP CONSTRAINT "FK_bdd0b584a79a5252889dbeb14fb";
ALTER TABLE "user_roles" DROP CONSTRAINT "FK_472b25323af01488f1f66a06b67";

-- 2. recreate each table with id first, preserving data/pk/uniques/indexes
-- users
ALTER TABLE "users" RENAME TO "users__reorder_old";
CREATE TABLE "users" (
  "id" uuid NOT NULL,
  "subject" character varying,
  "email" character varying NOT NULL,
  "normalizedEmail" character varying NOT NULL,
  "displayName" character varying NOT NULL,
  "countryCode" character varying,
  "createdAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL
);
INSERT INTO "users" ("id", "subject", "email", "normalizedEmail", "displayName", "countryCode", "createdAt", "updatedAt") SELECT "id", "subject", "email", "normalizedEmail", "displayName", "countryCode", "createdAt", "updatedAt" FROM "users__reorder_old";
DROP TABLE "users__reorder_old";
ALTER TABLE "users" ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);
CREATE UNIQUE INDEX uq_users_subject ON public.users USING btree (subject) WHERE (subject IS NOT NULL);
CREATE UNIQUE INDEX uq_users_normalized_email ON public.users USING btree ("normalizedEmail");

-- user_roles
ALTER TABLE "user_roles" RENAME TO "user_roles__reorder_old";
CREATE TABLE "user_roles" (
  "id" uuid NOT NULL,
  "roleName" character varying NOT NULL,
  "assignedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "userId" uuid NOT NULL
);
INSERT INTO "user_roles" ("id", "roleName", "assignedAt", "userId") SELECT "id", "roleName", "assignedAt", "userId" FROM "user_roles__reorder_old";
DROP TABLE "user_roles__reorder_old";
ALTER TABLE "user_roles" ADD CONSTRAINT "PK_8acd5cf26ebd158416f477de799" PRIMARY KEY (id);
CREATE INDEX idx_user_roles_user ON public.user_roles USING btree ("userId");
CREATE UNIQUE INDEX uq_user_roles_user_role ON public.user_roles USING btree ("userId", "roleName");

-- countries
ALTER TABLE "countries" RENAME TO "countries__reorder_old";
CREATE TABLE "countries" (
  "id" uuid NOT NULL,
  "code" character varying NOT NULL,
  "name" character varying NOT NULL
);
INSERT INTO "countries" ("id", "code", "name") SELECT "id", "code", "name" FROM "countries__reorder_old";
DROP TABLE "countries__reorder_old";
ALTER TABLE "countries" ADD CONSTRAINT "PK_b2d7006793e8697ab3ae2deff18" PRIMARY KEY (id);
ALTER TABLE "countries" ADD CONSTRAINT "UQ_b47cbb5311bad9c9ae17b8c1eda" UNIQUE (code);

-- holidays
ALTER TABLE "holidays" RENAME TO "holidays__reorder_old";
CREATE TABLE "holidays" (
  "id" uuid NOT NULL,
  "countryCode" character varying NOT NULL,
  "date" date NOT NULL,
  "name" character varying NOT NULL
);
INSERT INTO "holidays" ("id", "countryCode", "date", "name") SELECT "id", "countryCode", "date", "name" FROM "holidays__reorder_old";
DROP TABLE "holidays__reorder_old";
ALTER TABLE "holidays" ADD CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" PRIMARY KEY (id);
CREATE UNIQUE INDEX uq_holidays_country_date ON public.holidays USING btree ("countryCode", date);

-- leave_balances
ALTER TABLE "leave_balances" RENAME TO "leave_balances__reorder_old";
CREATE TABLE "leave_balances" (
  "id" uuid NOT NULL,
  "leaveType" character varying NOT NULL,
  "totalDays" numeric(6,2) NOT NULL,
  "availableDays" numeric(6,2) NOT NULL,
  "onHoldDays" numeric(6,2) NOT NULL,
  "spentDays" numeric(6,2) NOT NULL,
  "accruedDays" numeric(6,2) NOT NULL,
  "lastUpdatedAt" timestamp with time zone NOT NULL,
  "userId" uuid NOT NULL
);
INSERT INTO "leave_balances" ("id", "leaveType", "totalDays", "availableDays", "onHoldDays", "spentDays", "accruedDays", "lastUpdatedAt", "userId") SELECT "id", "leaveType", "totalDays", "availableDays", "onHoldDays", "spentDays", "accruedDays", "lastUpdatedAt", "userId" FROM "leave_balances__reorder_old";
DROP TABLE "leave_balances__reorder_old";
ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_a1d90dff48fb2bfd23a7163d077" PRIMARY KEY (id);
CREATE UNIQUE INDEX uq_leave_balances_user_type ON public.leave_balances USING btree ("userId", "leaveType");

-- leave_balance_changes
ALTER TABLE "leave_balance_changes" RENAME TO "leave_balance_changes__reorder_old";
CREATE TABLE "leave_balance_changes" (
  "id" uuid NOT NULL,
  "effectiveDate" date NOT NULL,
  "leaveType" character varying NOT NULL,
  "deltaDays" numeric(6,2) NOT NULL,
  "availableDays" numeric(6,2) NOT NULL,
  "onHoldDays" numeric(6,2) NOT NULL,
  "spentDays" numeric(6,2) NOT NULL,
  "reason" character varying NOT NULL,
  "note" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "userId" uuid NOT NULL
);
INSERT INTO "leave_balance_changes" ("id", "effectiveDate", "leaveType", "deltaDays", "availableDays", "onHoldDays", "spentDays", "reason", "note", "createdAt", "userId") SELECT "id", "effectiveDate", "leaveType", "deltaDays", "availableDays", "onHoldDays", "spentDays", "reason", "note", "createdAt", "userId" FROM "leave_balance_changes__reorder_old";
DROP TABLE "leave_balance_changes__reorder_old";
ALTER TABLE "leave_balance_changes" ADD CONSTRAINT "PK_19e19dffaa62ded3acd526006ed" PRIMARY KEY (id);
CREATE INDEX idx_leave_balance_changes_user_type ON public.leave_balance_changes USING btree ("userId", "leaveType", "createdAt");

-- leave_requests
ALTER TABLE "leave_requests" RENAME TO "leave_requests__reorder_old";
CREATE TABLE "leave_requests" (
  "id" uuid NOT NULL,
  "requesterDisplayName" character varying NOT NULL,
  "leaveType" character varying NOT NULL,
  "status" character varying NOT NULL,
  "startDate" date NOT NULL,
  "endDate" date NOT NULL,
  "requestedDays" numeric(6,2) NOT NULL,
  "submittedAt" timestamp with time zone NOT NULL,
  "comment" character varying,
  "decisionComment" character varying,
  "decidedAt" timestamp with time zone,
  "remainingHeldDays" numeric(6,2) NOT NULL,
  "spentDaysConsumed" numeric(6,2) NOT NULL,
  "leaveDays" text[] NOT NULL,
  "requesterUserId" uuid NOT NULL
);
INSERT INTO "leave_requests" ("id", "requesterDisplayName", "leaveType", "status", "startDate", "endDate", "requestedDays", "submittedAt", "comment", "decisionComment", "decidedAt", "remainingHeldDays", "spentDaysConsumed", "leaveDays", "requesterUserId") SELECT "id", "requesterDisplayName", "leaveType", "status", "startDate", "endDate", "requestedDays", "submittedAt", "comment", "decisionComment", "decidedAt", "remainingHeldDays", "spentDaysConsumed", "leaveDays", "requesterUserId" FROM "leave_requests__reorder_old";
DROP TABLE "leave_requests__reorder_old";
ALTER TABLE "leave_requests" ADD CONSTRAINT "PK_d3abcf9a16cef1450129e06fa9f" PRIMARY KEY (id);
CREATE INDEX idx_leave_requests_requester ON public.leave_requests USING btree ("requesterUserId");

-- leave_request_approvers
ALTER TABLE "leave_request_approvers" RENAME TO "leave_request_approvers__reorder_old";
CREATE TABLE "leave_request_approvers" (
  "id" uuid NOT NULL,
  "email" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "displayName" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "requestId" uuid NOT NULL
);
INSERT INTO "leave_request_approvers" ("id", "email", "kind", "displayName", "createdAt", "requestId") SELECT "id", "email", "kind", "displayName", "createdAt", "requestId" FROM "leave_request_approvers__reorder_old";
DROP TABLE "leave_request_approvers__reorder_old";
ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "PK_44ad60f495edb9a05ca83c70f78" PRIMARY KEY (id);
CREATE UNIQUE INDEX uq_leave_request_approvers_request_email ON public.leave_request_approvers USING btree ("requestId", email);

-- leave_approval_decisions
ALTER TABLE "leave_approval_decisions" RENAME TO "leave_approval_decisions__reorder_old";
CREATE TABLE "leave_approval_decisions" (
  "id" uuid NOT NULL,
  "actorDisplayName" character varying NOT NULL,
  "action" character varying NOT NULL,
  "occurredAt" timestamp with time zone NOT NULL,
  "comment" character varying,
  "requestId" uuid NOT NULL,
  "actorUserId" uuid NOT NULL
);
INSERT INTO "leave_approval_decisions" ("id", "actorDisplayName", "action", "occurredAt", "comment", "requestId", "actorUserId") SELECT "id", "actorDisplayName", "action", "occurredAt", "comment", "requestId", "actorUserId" FROM "leave_approval_decisions__reorder_old";
DROP TABLE "leave_approval_decisions__reorder_old";
ALTER TABLE "leave_approval_decisions" ADD CONSTRAINT "PK_4e9217a8af7326be269751064ec" PRIMARY KEY (id);
CREATE INDEX idx_leave_approval_decisions_request ON public.leave_approval_decisions USING btree ("requestId");

-- leave_request_activities
ALTER TABLE "leave_request_activities" RENAME TO "leave_request_activities__reorder_old";
CREATE TABLE "leave_request_activities" (
  "id" uuid NOT NULL,
  "actorDisplayName" character varying NOT NULL,
  "action" character varying NOT NULL,
  "occurredAt" timestamp with time zone NOT NULL,
  "comment" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "requestId" uuid NOT NULL,
  "actorUserId" uuid
);
INSERT INTO "leave_request_activities" ("id", "actorDisplayName", "action", "occurredAt", "comment", "createdAt", "requestId", "actorUserId") SELECT "id", "actorDisplayName", "action", "occurredAt", "comment", "createdAt", "requestId", "actorUserId" FROM "leave_request_activities__reorder_old";
DROP TABLE "leave_request_activities__reorder_old";
ALTER TABLE "leave_request_activities" ADD CONSTRAINT "PK_eee91f91711c732ad912157e377" PRIMARY KEY (id);
CREATE INDEX idx_leave_request_activities_request ON public.leave_request_activities USING btree ("requestId", "createdAt");

-- leave_audit_entries
ALTER TABLE "leave_audit_entries" RENAME TO "leave_audit_entries__reorder_old";
CREATE TABLE "leave_audit_entries" (
  "id" uuid NOT NULL,
  "employeeDisplayName" character varying NOT NULL,
  "status" character varying NOT NULL,
  "action" character varying NOT NULL,
  "occurredAt" timestamp with time zone NOT NULL,
  "leaveType" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "activityId" uuid NOT NULL,
  "requestId" uuid NOT NULL,
  "employeeId" uuid NOT NULL
);
INSERT INTO "leave_audit_entries" ("id", "employeeDisplayName", "status", "action", "occurredAt", "leaveType", "createdAt", "activityId", "requestId", "employeeId") SELECT "id", "employeeDisplayName", "status", "action", "occurredAt", "leaveType", "createdAt", "activityId", "requestId", "employeeId" FROM "leave_audit_entries__reorder_old";
DROP TABLE "leave_audit_entries__reorder_old";
ALTER TABLE "leave_audit_entries" ADD CONSTRAINT "PK_8063502d2b5e0a28cc8f6c5adb7" PRIMARY KEY (id);
ALTER TABLE "leave_audit_entries" ADD CONSTRAINT "UQ_c8604383da48dc065c6d05606c6" UNIQUE ("activityId");
CREATE INDEX idx_leave_audit_entries_occurred ON public.leave_audit_entries USING btree ("occurredAt", "createdAt");

-- notification_deliveries
ALTER TABLE "notification_deliveries" RENAME TO "notification_deliveries__reorder_old";
CREATE TABLE "notification_deliveries" (
  "id" uuid NOT NULL,
  "subject" character varying NOT NULL,
  "to" text[] NOT NULL,
  "cc" text[] NOT NULL,
  "approvalUrl" character varying,
  "status" character varying NOT NULL,
  "queuedAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL,
  "messageId" character varying,
  "errorMessage" character varying,
  "fingerprint" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  "requestId" uuid
);
INSERT INTO "notification_deliveries" ("id", "subject", "to", "cc", "approvalUrl", "status", "queuedAt", "updatedAt", "messageId", "errorMessage", "fingerprint", "createdAt", "requestId") SELECT "id", "subject", "to", "cc", "approvalUrl", "status", "queuedAt", "updatedAt", "messageId", "errorMessage", "fingerprint", "createdAt", "requestId" FROM "notification_deliveries__reorder_old";
DROP TABLE "notification_deliveries__reorder_old";
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "PK_81daeff81f237bd384f7cfc4a4c" PRIMARY KEY (id);
CREATE INDEX idx_notification_deliveries_fingerprint ON public.notification_deliveries USING btree (fingerprint);
CREATE INDEX idx_notification_deliveries_request ON public.notification_deliveries USING btree ("requestId");

-- 3. restore every foreign key
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_521adef4062ef84ff39490f1a91" FOREIGN KEY ("countryCode") REFERENCES countries(code) ON DELETE RESTRICT;
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_fd077f9cfc97d4a6703027c5c5d" FOREIGN KEY ("sourceCalendarId") REFERENCES holiday_calendars(id) ON DELETE SET NULL;
ALTER TABLE "leave_allocations" ADD CONSTRAINT "FK_6b3bac3a86087b3e14434956685" FOREIGN KEY ("setByUserId") REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE "leave_allocations" ADD CONSTRAINT "FK_a5fc48d6b3e7b39bbd2376a8aeb" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "leave_approval_decisions" ADD CONSTRAINT "FK_0bc4d920fb3de2730e1327b866d" FOREIGN KEY ("requestId") REFERENCES leave_requests(id) ON DELETE CASCADE;
ALTER TABLE "leave_balance_changes" ADD CONSTRAINT "FK_1865db77a6240984d05e60211ae" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE "leave_balances" ADD CONSTRAINT "FK_aae940169a5f4c5df2c79d0e080" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "leave_request_activities" ADD CONSTRAINT "FK_943e3073dded29faac709c55fbc" FOREIGN KEY ("requestId") REFERENCES leave_requests(id) ON DELETE CASCADE;
ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "FK_fe6a0fc72e4d6b4704f266cf408" FOREIGN KEY ("requestId") REFERENCES leave_requests(id) ON DELETE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "FK_ccf03ef9ce51273f64eaef3e7ac" FOREIGN KEY ("requesterUserId") REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "FK_73495b72b8069ba0a85a0b45c13" FOREIGN KEY ("requestId") REFERENCES leave_requests(id) ON DELETE SET NULL;
ALTER TABLE "user_project_memberships" ADD CONSTRAINT "FK_3678bdfa7f7d854c23cd084ae1b" FOREIGN KEY ("projectId") REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE "user_project_memberships" ADD CONSTRAINT "FK_bdd0b584a79a5252889dbeb14fb" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "FK_472b25323af01488f1f66a06b67" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
`)
  }

  public async down(): Promise<void> {
    // Physical column order only; not meaningfully reversible and has no
    // functional effect. No-op on revert.
  }
}
