import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLeavePolicies1785445795595 implements MigrationInterface {
    name = 'AddLeavePolicies1785445795595'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "leave_policies" ("id" uuid NOT NULL, "name" character varying NOT NULL, "description" character varying, "vacationDays" numeric(6,2) NOT NULL, "sickDays" numeric(6,2) NOT NULL, "vacationAnnualIncrement" numeric(6,2) NOT NULL DEFAULT '0', "vacationIncrementCapDays" numeric(6,2), "probationMonths" integer NOT NULL DEFAULT '0', "paidSickDuringProbation" boolean NOT NULL DEFAULT false, "effectiveFrom" date NOT NULL, "effectiveTo" date, "isDefault" boolean NOT NULL DEFAULT false, "termsFingerprint" character varying(160) NOT NULL, "createdByUserId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "chk_leave_policies_validity" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"), CONSTRAINT "PK_7d3b46bd2974cbb56e3831f3f34" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_policies_default" ON "leave_policies" ("isDefault") WHERE "isDefault" = true`);
        await queryRunner.query(`CREATE INDEX "idx_leave_policies_fingerprint" ON "leave_policies" ("termsFingerprint") `);
        await queryRunner.query(`CREATE TABLE "leave_policy_memberships" ("id" uuid NOT NULL, "userId" uuid NOT NULL, "policyId" uuid NOT NULL, "effectiveFrom" date NOT NULL, "effectiveTo" date, "supersededByRowId" uuid, "assignedByUserId" uuid, "note" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_6fbad031f77af001ac777cbfca2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_leave_policy_memberships_policy" ON "leave_policy_memberships" ("policyId") `);
        await queryRunner.query(`CREATE INDEX "idx_leave_policy_memberships_user_from" ON "leave_policy_memberships" ("userId", "effectiveFrom") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_policy_memberships_open" ON "leave_policy_memberships" ("userId") WHERE "effectiveTo" IS NULL AND "supersededByRowId" IS NULL`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD "sourcePolicyId" uuid`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum" RENAME TO "audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'policy.created', 'policy.updated', 'policy.superseded', 'policy.default_changed', 'policy.membership_assigned', 'policy.membership_transferred', 'policy.membership_transfer_scheduled', 'policy.membership_transfer_schedule_canceled', 'policy.membership_transfer_blocked', 'policy.membership_backdated', 'policy.allocation_materialized', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum" RENAME TO "audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday', 'policy')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum" USING "category"::"text"::"public"."audit_logs_category_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
        await queryRunner.query(`ALTER TABLE "leave_policies" ADD CONSTRAINT "FK_3517d9940ecb7bd6b25203d81d0" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD CONSTRAINT "FK_eba17922e7aff402d73632ff9fc" FOREIGN KEY ("sourcePolicyId") REFERENCES "leave_policies"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" ADD CONSTRAINT "FK_118c3720e51148d821d1eed5218" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" ADD CONSTRAINT "FK_9675cefe988ab7f2851e935917a" FOREIGN KEY ("policyId") REFERENCES "leave_policies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" ADD CONSTRAINT "FK_c2be54d1986567cf8bfc57a266a" FOREIGN KEY ("supersededByRowId") REFERENCES "leave_policy_memberships"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" ADD CONSTRAINT "FK_bc124062afb94a796dc71eb0bef" FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" DROP CONSTRAINT "FK_bc124062afb94a796dc71eb0bef"`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" DROP CONSTRAINT "FK_c2be54d1986567cf8bfc57a266a"`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" DROP CONSTRAINT "FK_9675cefe988ab7f2851e935917a"`);
        await queryRunner.query(`ALTER TABLE "leave_policy_memberships" DROP CONSTRAINT "FK_118c3720e51148d821d1eed5218"`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP CONSTRAINT "FK_eba17922e7aff402d73632ff9fc"`);
        await queryRunner.query(`ALTER TABLE "leave_policies" DROP CONSTRAINT "FK_3517d9940ecb7bd6b25203d81d0"`);
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum_old" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum_old" USING "category"::"text"::"public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum_old" RENAME TO "audit_logs_category_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_eventtype_enum_old" AS ENUM('user.login', 'user.provisioned', 'user.profile_synced', 'user.roles_assigned', 'user.login_refused', 'user.deactivated', 'user.reactivated', 'user.sync_conflict', 'user.identity_conflict', 'ldap_sync.completed', 'ldap_sync.failed', 'employee.profile_updated', 'employee.allocation_updated', 'employee.leave_data_reset', 'leave_request.submitted', 'leave_request.cancelled', 'leave_request.approved', 'leave_request.rejected', 'leave_request.force_approved', 'leave_request.force_rejected', 'leave_request.approver_removed', 'leave_request.modification_submitted', 'leave_request.superseded', 'settings.updated', 'country.created', 'country.updated', 'country.deleted', 'holiday_calendar.replaced', 'holiday_calendar.cloned', 'holiday_calendar.deleted')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "eventType" TYPE "public"."audit_logs_eventtype_enum_old" USING "eventType"::"text"::"public"."audit_logs_eventtype_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_eventtype_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_eventtype_enum_old" RENAME TO "audit_logs_eventtype_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "id", "occurredAt") `);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP COLUMN "sourcePolicyId"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_policy_memberships_open"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_policy_memberships_user_from"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_policy_memberships_policy"`);
        await queryRunner.query(`DROP TABLE "leave_policy_memberships"`);
        await queryRunner.query(`DROP INDEX "public"."idx_leave_policies_fingerprint"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_policies_default"`);
        await queryRunner.query(`DROP TABLE "leave_policies"`);
    }

}
