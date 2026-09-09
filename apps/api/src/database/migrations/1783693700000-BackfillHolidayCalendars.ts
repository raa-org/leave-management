import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written, not generated) paired with AddHolidayCalendarId
 * and FinalizeHolidayCalendarLink. Its timestamp runs it AFTER calendarId exists
 * (nullable) and BEFORE calendarId is made NOT NULL and countryCode is dropped.
 *
 * Moves the flat `holidays(countryCode, date)` rows under per-year
 * `holiday_calendars(countryCode, year)`:
 *   1. ensure a country row exists for every holiday countryCode (holiday_calendars
 *      .countryCode -> countries.code is ON DELETE RESTRICT, so the parent must
 *      exist before the calendar is inserted);
 *   2. synthesize one calendar per distinct (countryCode, year-of-date);
 *   3. point each holiday at its (countryCode, year) calendar.
 *
 * Non-destructive: no holiday row is deleted; only calendarId is populated.
 */
export class BackfillHolidayCalendars1783693700000
  implements MigrationInterface
{
  name = 'BackfillHolidayCalendars1783693700000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Ensure a country exists for every holiday countryCode.
    await queryRunner.query(`
      INSERT INTO "countries" ("id", "code", "name")
      SELECT gen_random_uuid(), h."countryCode", h."countryCode"
      FROM (SELECT DISTINCT "countryCode" FROM "holidays") h
      WHERE NOT EXISTS (
        SELECT 1 FROM "countries" c WHERE c."code" = h."countryCode"
      )
    `)

    // 2. One calendar per distinct (countryCode, year(date)).
    await queryRunner.query(`
      INSERT INTO "holiday_calendars"
        ("id", "countryCode", "year", "name", "sourceCalendarId", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        d."countryCode",
        d."year",
        d."countryCode" || ' ' || d."year",
        NULL,
        now(),
        now()
      FROM (
        SELECT DISTINCT "countryCode", EXTRACT(YEAR FROM "date")::int AS "year"
        FROM "holidays"
      ) d
      ON CONFLICT ("countryCode", "year") DO NOTHING
    `)

    // 3. Point each holiday at its (countryCode, year) calendar.
    await queryRunner.query(`
      UPDATE "holidays" h
      SET "calendarId" = hc."id"
      FROM "holiday_calendars" hc
      WHERE hc."countryCode" = h."countryCode"
        AND hc."year" = EXTRACT(YEAR FROM h."date")::int
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort: detach holidays so AddHolidayCalendarId.down can drop the
    // column. Synthesized calendar rows are left in place (harmless).
    await queryRunner.query(`UPDATE "holidays" SET "calendarId" = NULL`)
  }
}
