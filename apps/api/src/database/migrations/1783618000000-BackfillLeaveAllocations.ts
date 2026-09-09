import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written). Seeds leave_allocations from the existing
 * per-(user, leaveType, year) balances so every current balance keeps its
 * admin-set annual totalDays once the allocation table becomes the source of
 * truth (the balance's totalDays is derived from settings today and is dropped
 * in a later phase). New years are seeded lazily at runtime by ensureAllocation.
 */
export class BackfillLeaveAllocations1783618000000
  implements MigrationInterface
{
  name = 'BackfillLeaveAllocations1783618000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "leave_allocations"
        ("id", "userId", "year", "leaveType", "totalDays", "carriedOverDays",
         "createdAt", "updatedAt")
      SELECT gen_random_uuid(), b."userId", b."year", b."leaveType",
             b."totalDays", 0, now(), now()
      FROM "leave_balances" b
      WHERE NOT EXISTS (
        SELECT 1 FROM "leave_allocations" a
        WHERE a."userId" = b."userId"
          AND a."year" = b."year"
          AND a."leaveType" = b."leaveType"
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort inverse: remove allocations that mirror a current balance and
    // were never edited (setByUserId IS NULL, no carryover). Newly seeded years
    // are left in place.
    await queryRunner.query(`
      DELETE FROM "leave_allocations" a
      USING "leave_balances" b
      WHERE a."userId" = b."userId"
        AND a."year" = b."year"
        AND a."leaveType" = b."leaveType"
        AND a."setByUserId" IS NULL
        AND a."carriedOverDays" = 0
    `)
  }
}
