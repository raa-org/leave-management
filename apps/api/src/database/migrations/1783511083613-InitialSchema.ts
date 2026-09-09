import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1783511083613 implements MigrationInterface {
    name = 'InitialSchema1783511083613'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "countries" ("code" character varying NOT NULL, "name" character varying NOT NULL, CONSTRAINT "PK_b47cbb5311bad9c9ae17b8c1eda" PRIMARY KEY ("code"))`);
        await queryRunner.query(`CREATE TABLE "holidays" ("holidayId" character varying NOT NULL, "countryCode" character varying NOT NULL, "date" date NOT NULL, "name" character varying NOT NULL, CONSTRAINT "PK_49353757c7bd523a218c7d0e789" PRIMARY KEY ("holidayId"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_holidays_country_date" ON "holidays" ("countryCode", "date") `);
        await queryRunner.query(`CREATE TABLE "leave_approval_decisions" ("decisionId" character varying NOT NULL, "requestId" character varying NOT NULL, "actorUserId" character varying NOT NULL, "actorDisplayName" character varying NOT NULL, "action" character varying NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "comment" character varying, CONSTRAINT "PK_7830ec0c17fac973e076b57ca27" PRIMARY KEY ("decisionId"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_approval_decisions_request" ON "leave_approval_decisions" ("requestId") `);
        await queryRunner.query(`CREATE TABLE "leave_audit_entries" ("id" SERIAL NOT NULL, "activityId" character varying NOT NULL, "requestId" character varying NOT NULL, "employeeId" character varying NOT NULL, "employeeDisplayName" character varying NOT NULL, "status" character varying NOT NULL, "action" character varying NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "leaveType" character varying NOT NULL, CONSTRAINT "UQ_c8604383da48dc065c6d05606c6" UNIQUE ("activityId"), CONSTRAINT "PK_8063502d2b5e0a28cc8f6c5adb7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_audit_entries_occurred" ON "leave_audit_entries" ("occurredAt", "id") `);
        await queryRunner.query(`CREATE TABLE "leave_balances" ("userId" character varying NOT NULL, "leaveType" character varying NOT NULL, "totalDays" numeric(6,2) NOT NULL, "availableDays" numeric(6,2) NOT NULL, "onHoldDays" numeric(6,2) NOT NULL, "spentDays" numeric(6,2) NOT NULL, "accruedDays" numeric(6,2) NOT NULL, "lastUpdatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_0f69842491cdc23208d6698e0c5" PRIMARY KEY ("userId", "leaveType"))`);
        await queryRunner.query(`CREATE TABLE "leave_balance_changes" ("id" SERIAL NOT NULL, "userId" character varying NOT NULL, "effectiveDate" date NOT NULL, "leaveType" character varying NOT NULL, "deltaDays" numeric(6,2) NOT NULL, "availableDays" numeric(6,2) NOT NULL, "onHoldDays" numeric(6,2) NOT NULL, "spentDays" numeric(6,2) NOT NULL, "reason" character varying NOT NULL, "note" character varying, CONSTRAINT "PK_19e19dffaa62ded3acd526006ed" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_balance_changes_user_type" ON "leave_balance_changes" ("userId", "leaveType", "id") `);
        await queryRunner.query(`CREATE TABLE "leave_requests" ("requestId" character varying NOT NULL, "requesterUserId" character varying NOT NULL, "requesterDisplayName" character varying NOT NULL, "leaveType" character varying NOT NULL, "status" character varying NOT NULL, "startDate" date NOT NULL, "endDate" date NOT NULL, "requestedDays" numeric(6,2) NOT NULL, "submittedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "comment" character varying, "decisionComment" character varying, "decidedAt" TIMESTAMP WITH TIME ZONE, "remainingHeldDays" numeric(6,2) NOT NULL, "spentDaysConsumed" numeric(6,2) NOT NULL, "leaveDays" text array NOT NULL, CONSTRAINT "PK_2f7f8dcd4cebd0f0cd6a034911c" PRIMARY KEY ("requestId"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_requests_requester" ON "leave_requests" ("requesterUserId") `);
        await queryRunner.query(`CREATE TABLE "leave_request_activities" ("id" SERIAL NOT NULL, "requestId" character varying NOT NULL, "actorUserId" character varying, "actorDisplayName" character varying NOT NULL, "action" character varying NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "comment" character varying, CONSTRAINT "PK_eee91f91711c732ad912157e377" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_request_activities_request" ON "leave_request_activities" ("requestId", "id") `);
        await queryRunner.query(`CREATE TABLE "leave_request_approvers" ("id" SERIAL NOT NULL, "requestId" character varying NOT NULL, "email" character varying NOT NULL, "kind" character varying NOT NULL, "displayName" character varying, CONSTRAINT "PK_44ad60f495edb9a05ca83c70f78" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_request_approvers_request_email" ON "leave_request_approvers" ("requestId", "email") `);
        await queryRunner.query(`CREATE TABLE "leave_settings" ("id" integer NOT NULL, "defaultVacationDays" integer NOT NULL, "defaultSickDays" integer NOT NULL, "defaultApproverEmails" text array NOT NULL, "defaultCcApproverEmails" text array NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_59fb7da917e884da56871e3c69f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("userId" character varying NOT NULL, "subject" character varying, "email" character varying NOT NULL, "normalizedEmail" character varying NOT NULL, "displayName" character varying NOT NULL, "countryCode" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_8bf09ba754322ab9c22a215c919" PRIMARY KEY ("userId"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_subject" ON "users" ("subject") WHERE subject IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_users_normalized_email" ON "users" ("normalizedEmail") `);
        await queryRunner.query(`CREATE TABLE "user_roles" ("userId" character varying NOT NULL, "roleName" character varying NOT NULL, "assignedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6327cc433074c3efddbe2ba390f" PRIMARY KEY ("userId", "roleName"))`);
        await queryRunner.query(`CREATE TABLE "notification_deliveries" ("id" SERIAL NOT NULL, "requestId" character varying, "subject" character varying NOT NULL, "to" text array NOT NULL, "cc" text array NOT NULL, "approvalUrl" character varying, "status" character varying NOT NULL, "queuedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "messageId" character varying, "errorMessage" character varying, "fingerprint" character varying NOT NULL, CONSTRAINT "PK_81daeff81f237bd384f7cfc4a4c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_fingerprint" ON "notification_deliveries" ("fingerprint") `);
        await queryRunner.query(`CREATE INDEX "idx_notification_deliveries_request" ON "notification_deliveries" ("requestId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_notification_deliveries_request"`);
        await queryRunner.query(`DROP INDEX "public"."idx_notification_deliveries_fingerprint"`);
        await queryRunner.query(`DROP TABLE "notification_deliveries"`);
        await queryRunner.query(`DROP TABLE "user_roles"`);
        await queryRunner.query(`DROP INDEX "public"."uq_users_normalized_email"`);
        await queryRunner.query(`DROP INDEX "public"."uq_users_subject"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "leave_settings"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_request_approvers_request_email"`);
        await queryRunner.query(`DROP TABLE "leave_request_approvers"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_request_activities_request"`);
        await queryRunner.query(`DROP TABLE "leave_request_activities"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_requests_requester"`);
        await queryRunner.query(`DROP TABLE "leave_requests"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_balance_changes_user_type"`);
        await queryRunner.query(`DROP TABLE "leave_balance_changes"`);
        await queryRunner.query(`DROP TABLE "leave_balances"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_audit_entries_occurred"`);
        await queryRunner.query(`DROP TABLE "leave_audit_entries"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_approval_decisions_request"`);
        await queryRunner.query(`DROP TABLE "leave_approval_decisions"`);
        await queryRunner.query(`DROP INDEX "public"."uq_holidays_country_date"`);
        await queryRunner.query(`DROP TABLE "holidays"`);
        await queryRunner.query(`DROP TABLE "countries"`);
    }

}
