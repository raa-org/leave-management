import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written). The carryoverCapMode column lands with a
 * `percent` default because that is the company policy a fresh install should
 * start on. A settings row that predates the column, however, was written when
 * `capped` could only ever mean a fixed day count, so inheriting the new
 * default would silently reinterpret its cap as a percentage at the next year
 * close. Pin such a row to `days`, which is what it always meant.
 */
export class CarryoverCapModeBackfill1785351300000
  implements MigrationInterface
{
  name = 'CarryoverCapModeBackfill1785351300000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "leave_settings"
      SET "carryoverCapMode" = 'days'
      WHERE "carryoverPolicy" = 'capped'
    `)
  }

  public async down(): Promise<void> {
    // No inverse: the structural migration drops the column outright, and the
    // pre-existing rows carried no cap mode to restore.
  }
}
