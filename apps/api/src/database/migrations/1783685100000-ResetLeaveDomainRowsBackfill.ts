import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written, not generated) paired with UseNativeEnums.
 *
 * DESTRUCTIVE. Its earlier timestamp guarantees it runs BEFORE UseNativeEnums.
 *
 * TypeORM's generator converts a `varchar` column to a native pg-enum by
 * dropping and re-adding the column (it does not emit an `ALTER COLUMN ... TYPE
 * ... USING` cast). Re-adding a NOT NULL enum column fails on a populated table
 * (23502), so the rows carrying the closed-set columns must be cleared first.
 *
 * We accept the data loss at this stage of the redesign (the schema has not
 * shipped to an environment with data worth keeping). Only leave-domain ROWS
 * are cleared here; users, countries, projects, memberships, holiday calendars
 * and the singleton leave_settings row survive. One caveat on that survivor:
 * UseNativeEnums still rewrites leave_settings.carryoverPolicy in place
 * (DROP COLUMN + ADD ... NOT NULL DEFAULT 'none', no USING cast), so the row
 * keeps its identity but its carryover policy RESETS to 'none' like every other
 * enum column's value - an admin re-sets it if a non-default policy was
 * configured. Role assignments are re-provisioned on the next OIDC login.
 *
 * This migration pair is FORWARD-ONLY. Reverting is not supported on a
 * populated database: this data-migration cannot un-truncate (down() is a
 * no-op), and UseNativeEnums.down() re-adds NOT NULL varchar columns with no
 * DEFAULT, which throws 23502 once any row exists. If either migration ever
 * needs to run - or revert - against real production data, replace the pair
 * with a hand-written non-destructive `ALTER COLUMN ... TYPE ... USING
 * col::text::enum` conversion, which is reversible and also preserves the
 * leave_settings.carryoverPolicy value.
 */
export class ResetLeaveDomainRowsBackfill1783685100000
  implements MigrationInterface
{
  name = 'ResetLeaveDomainRowsBackfill1783685100000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `TRUNCATE TABLE ` +
        `"leave_requests", ` +
        `"leave_balances", ` +
        `"leave_balance_changes", ` +
        `"leave_allocations", ` +
        `"leave_approval_decisions", ` +
        `"leave_request_approvers", ` +
        `"leave_request_activities", ` +
        `"notification_deliveries", ` +
        `"user_roles" ` +
        `CASCADE`,
    )
  }

  public async down(): Promise<void> {
    // Irreversible: truncated rows cannot be restored.
  }
}
