import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written, not generated) paired with
 * AddForeignKeysToExistingTables. Its earlier timestamp guarantees it runs
 * BEFORE the FK constraints are added, so adding the nullable `SET NULL`
 * foreign key cannot fail on a pre-existing dangling reference.
 *
 * Only notification_deliveries.requestId is cleaned: it is the one nullable
 * SET NULL reference among the FKs added in this phase, and nulling a dangling
 * value is non-destructive (a stale requestId simply becomes NULL, which the
 * SET NULL FK would produce on delete anyway). The other new FKs are on NOT
 * NULL CASCADE/RESTRICT columns whose parents are always created first by the
 * app; an orphan there would indicate real corruption, so the FK add should
 * fail loudly rather than silently mutate rows. (users.countryCode and
 * leave_request_activities.actorUserId FKs are intentionally deferred to later
 * phases, so they are NOT cleaned here.)
 */
export class ForeignKeyOrphansBackfill1783611410000
  implements MigrationInterface
{
  name = 'ForeignKeyOrphansBackfill1783611410000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notification_deliveries"
      SET "requestId" = NULL
      WHERE "requestId" IS NOT NULL
        AND "requestId" NOT IN (SELECT "id" FROM "leave_requests")
    `)
  }

  public async down(): Promise<void> {
    // Irreversible: the original dangling values are not recoverable, and they
    // were invalid references by definition. No-op on revert.
  }
}
