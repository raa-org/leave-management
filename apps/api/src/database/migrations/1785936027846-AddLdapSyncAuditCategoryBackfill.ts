import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DATA MIGRATION (hand-written), paired with AddLdapSyncAuditCategory. An audit
 * row's category is a pure function of its event type, stamped once at insert
 * time and compared as a stored value when the feed is filtered — so the three
 * event types that moved to `ldap_sync` keep the `employee` they were written
 * with, and the new filter would answer for post-deploy runs only while the
 * Employee filter kept answering for the older ones. Re-file them so one event
 * type means one category in the data, as the contract states.
 */
export class AddLdapSyncAuditCategoryBackfill1785936027846 implements MigrationInterface {
    name = 'AddLdapSyncAuditCategoryBackfill1785936027846'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "audit_logs"
            SET "category" = 'ldap_sync'
            WHERE "eventType" IN ('ldap_sync.completed', 'ldap_sync.failed', 'user.sync_conflict')
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Exact inverse: all three event types were filed under `employee` from the
        // day they existed until the paired migration. Keyed on the event type, not
        // on the category, so it also catches rows written after this backfill ran —
        // which is what lets the paired migration's own down() cast the column back
        // to an enum that has no `ldap_sync` value.
        await queryRunner.query(`
            UPDATE "audit_logs"
            SET "category" = 'employee'
            WHERE "eventType" IN ('ldap_sync.completed', 'ldap_sync.failed', 'user.sync_conflict')
        `)
    }

}
