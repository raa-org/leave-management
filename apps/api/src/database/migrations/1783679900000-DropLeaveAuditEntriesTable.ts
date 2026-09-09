import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Hand-written structural migration: drops leave_audit_entries. Paired with the
 * generated ReplaceAuditTableWithActivityFeed (which adds statusAtEvent + the
 * feed index). TypeORM's migration:generate never emits DROP TABLE for a table
 * whose entity was removed (it leaves unmanaged tables alone to avoid data
 * loss), so the drop is hand-written. The global admin feed is now derived from
 * leave_request_activities joined to leave_requests + users, so this snapshot
 * table (a near-duplicate of the activity timeline) is redundant. Forward-only:
 * down() is a no-op (the table and its rows are intentionally gone).
 */
export class DropLeaveAuditEntriesTable1783679900000
  implements MigrationInterface
{
  name = 'DropLeaveAuditEntriesTable1783679900000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "leave_audit_entries"`)
  }

  public async down(): Promise<void> {
    // Forward-only: the audit snapshot table is intentionally removed and its
    // data is not reconstructable. No-op on revert.
  }
}
