import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The increment PERIOD of a leave policy: "+5 vacation days every 3 years"
 * rather than only "+N every year".
 *
 * Nothing is recomputed. Every existing row means "every year", which is what
 * the default 1 says, and the fingerprint omits the period entirely at 1, so
 * the stored fingerprints (including the SQL literals of the backfill
 * migration) stay byte-identical.
 */
export class AddVacationIncrementEveryYears1786622486901
  implements MigrationInterface
{
  name = 'AddVacationIncrementEveryYears1786622486901'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_policies" ADD "vacationIncrementEveryYears" integer NOT NULL DEFAULT '1'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "leave_policies" DROP COLUMN "vacationIncrementEveryYears"`,
    )
  }
}
