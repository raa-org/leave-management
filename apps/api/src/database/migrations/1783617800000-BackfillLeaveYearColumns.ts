import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written) paired with AddLeaveYearColumns and the
 * following SetLeaveYearNotNull. Fills the new year columns for existing rows
 * from the most reliable date each table carries, so the columns can then be
 * made NOT NULL:
 *   - leave_balances.year        <- year of lastUpdatedAt (the balance is current)
 *   - leave_balance_changes.year <- year of effectiveDate (the ledger event date)
 *   - leave_requests.leaveYear   <- year of startDate (the leave period)
 */
export class BackfillLeaveYearColumns1783617800000
  implements MigrationInterface
{
  name = 'BackfillLeaveYearColumns1783617800000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "leave_balances"
      SET "year" = EXTRACT(YEAR FROM "lastUpdatedAt")::int
      WHERE "year" IS NULL
    `)
    await queryRunner.query(`
      UPDATE "leave_balance_changes"
      SET "year" = EXTRACT(YEAR FROM "effectiveDate")::int
      WHERE "year" IS NULL
    `)
    await queryRunner.query(`
      UPDATE "leave_requests"
      SET "leaveYear" = EXTRACT(YEAR FROM "startDate")::int
      WHERE "leaveYear" IS NULL
    `)
  }

  public async down(): Promise<void> {
    // Irreversible data backfill. No-op on revert.
  }
}
