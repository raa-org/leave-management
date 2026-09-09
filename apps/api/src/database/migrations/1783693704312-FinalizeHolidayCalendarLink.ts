import { MigrationInterface, QueryRunner } from "typeorm";

export class FinalizeHolidayCalendarLink1783693704312 implements MigrationInterface {
    name = 'FinalizeHolidayCalendarLink1783693704312'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_holidays_country_date"`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP COLUMN "countryCode"`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP CONSTRAINT "FK_9cb151cd093c8d3910085d71746"`);
        await queryRunner.query(`ALTER TABLE "holidays" ALTER COLUMN "calendarId" SET NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_holidays_calendar_date" ON "holidays" ("calendarId", "date") `);
        await queryRunner.query(`ALTER TABLE "holidays" ADD CONSTRAINT "FK_9cb151cd093c8d3910085d71746" FOREIGN KEY ("calendarId") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" DROP CONSTRAINT "FK_9cb151cd093c8d3910085d71746"`);
        await queryRunner.query(`DROP INDEX "public"."uq_holidays_calendar_date"`);
        await queryRunner.query(`ALTER TABLE "holidays" ALTER COLUMN "calendarId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD CONSTRAINT "FK_9cb151cd093c8d3910085d71746" FOREIGN KEY ("calendarId") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD "countryCode" character varying NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_holidays_country_date" ON "holidays" ("countryCode", "date") `);
    }

}
