import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Widen every day quantity from numeric(6,2) to numeric(7,3), because leave is
 * about to be bookable by the hour: an eight-hour workday puts one hour at
 * 0.125 days, so a five-hour absence is 0.625 days and two decimals would store
 * it as 0.63. Widening is value-preserving (every stored two-decimal figure is
 * exactly representable at three), and it goes with `roundDays` moving to the
 * same quantum: the books pre-round before every write, so a column left at
 * scale 2 would silently round a figure the books consider exact and the
 * ledger's running snapshots would stop adding up.
 *
 * The down() narrows the columns back, which ROUNDS any third decimal already
 * written. It is a schema rollback, not a data rollback: run it only on a
 * database that has not booked sub-day leave yet.
 */
export class WidenDayColumnsToHourGrid1786556872035
  implements MigrationInterface
{
  name = 'WidenDayColumnsToHourGrid1786556872035'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "sickDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationAnnualIncrement" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationIncrementCapDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "totalDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "carriedOverDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "manualAdjustmentDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "requestedDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "remainingHeldDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "spentDaysConsumed" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "accruedDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "onHoldDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "spentDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "deltaDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "accruedDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "onHoldDays" TYPE numeric(7,3)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "spentDays" TYPE numeric(7,3)`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "spentDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "onHoldDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "accruedDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balance_changes" ALTER COLUMN "deltaDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "spentDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "onHoldDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_balances" ALTER COLUMN "accruedDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "spentDaysConsumed" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "remainingHeldDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ALTER COLUMN "requestedDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "manualAdjustmentDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "carriedOverDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_allocations" ALTER COLUMN "totalDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationIncrementCapDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationAnnualIncrement" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "sickDays" TYPE numeric(6,2)`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ALTER COLUMN "vacationDays" TYPE numeric(6,2)`,
    )
  }
}
