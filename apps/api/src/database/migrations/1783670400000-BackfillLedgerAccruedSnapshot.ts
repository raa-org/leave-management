import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written). Backfills the new ledger accruedDays snapshot
 * from the old availableDays snapshot. Historically the ledger stored a running
 * `availableDays` that already netted holds and spend
 * (availableDays = accrued - onHold - spent), so the accrued snapshot is
 * recovered as availableDays + onHoldDays + spentDays. Pairs with
 * SetLedgerAccruedNotNull, which then makes it NOT NULL and drops availableDays.
 */
export class BackfillLedgerAccruedSnapshot1783670400000
  implements MigrationInterface
{
  name = 'BackfillLedgerAccruedSnapshot1783670400000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "leave_balance_changes"
      SET "accruedDays" = "availableDays" + "onHoldDays" + "spentDays"
      WHERE "accruedDays" IS NULL
    `)
  }

  public async down(): Promise<void> {
    // Irreversible data backfill. No-op on revert.
  }
}
