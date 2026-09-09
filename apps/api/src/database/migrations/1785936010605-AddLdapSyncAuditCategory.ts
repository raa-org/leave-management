import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLdapSyncAuditCategory1785936010605 implements MigrationInterface {
    name = 'AddLdapSyncAuditCategory1785936010605'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Adds the `ldap_sync` category; which events file under it is stated
        // once, on AuditCategory in the shared contracts. The paired
        // AddLdapSyncAuditCategoryBackfill re-files the rows written before the
        // value existed; recreating the type (rather than ALTER TYPE ... ADD
        // VALUE, which has no inverse) is what keeps a down() possible at all.
        //
        // The list is the FULL current value set, `policy` included: recreating
        // a pg enum replaces the whole type, so a list missing a value another
        // migration added would abort the cast on any row using it — or
        // silently drop the value from the type (same union rule as in
        // AddLdapSyncAuditEvents).
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum" RENAME TO "audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday', 'policy', 'ldap_sync')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum" USING "category"::"text"::"public"."audit_logs_category_enum"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverts run newest first, so the paired backfill has already put
        // every `ldap_sync` row back under `employee` before this cast runs. A
        // row still holding the value aborts the revert rather than being
        // silently relabelled. Drops ONLY this migration's value: `policy`
        // stays (it belongs to AddLeavePolicies). Two generator artifacts are
        // corrected by hand here: the value list keeps the declaration order
        // the type has always had (the generator emits it alphabetized), and
        // the index is recreated with its real column order — the generator
        // reverses it, which would leave category-filtered keyset reads
        // unindexed after a revert.
        await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_category"`);
        await queryRunner.query(`CREATE TYPE "public"."audit_logs_category_enum_old" AS ENUM('auth', 'role', 'employee', 'leave_request', 'approval', 'settings', 'country', 'holiday', 'policy')`);
        await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "category" TYPE "public"."audit_logs_category_enum_old" USING "category"::"text"::"public"."audit_logs_category_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."audit_logs_category_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."audit_logs_category_enum_old" RENAME TO "audit_logs_category_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_category" ON "audit_logs" ("category", "occurredAt", "id") `);
    }

}
