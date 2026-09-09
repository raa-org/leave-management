import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Sub-day leave, stored as a fraction per date: `dayPortions` is index-aligned
 * with the existing `leaveDays`, so [1, 0.5, 1] is a three-day request whose
 * middle day is four hours. An EMPTY array means every date is a full day,
 * which is exactly what every existing row is — the same idiom as an empty
 * `unpaidLeaveDays` meaning fully paid, and the reason neither needs a backfill.
 *
 * `hoursPerDay` is the divisor that turns a booking in hours into that fraction.
 * Org-wide and whole hours: a per-employee day length would make one person's
 * day worth more balance than another's.
 */
export class AddDayPortionsAndHoursPerDay1786560489411
  implements MigrationInterface
{
  name = 'AddDayPortionsAndHoursPerDay1786560489411'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_requests" ADD "dayPortions" numeric(4,3) array NOT NULL DEFAULT '{}'`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_settings" ADD "hoursPerDay" integer NOT NULL DEFAULT '8'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_settings" DROP COLUMN "hoursPerDay"`,
    )
    await queryRunner.query(
      `ALTER TABLE "leave_requests" DROP COLUMN "dayPortions"`,
    )
  }
}
