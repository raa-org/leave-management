import { MigrationInterface, QueryRunner } from "typeorm";

export class AddHolidayCalendarId1783693629044 implements MigrationInterface {
    name = 'AddHolidayCalendarId1783693629044'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" ADD "calendarId" uuid`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD CONSTRAINT "FK_9cb151cd093c8d3910085d71746" FOREIGN KEY ("calendarId") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" DROP CONSTRAINT "FK_9cb151cd093c8d3910085d71746"`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP COLUMN "calendarId"`);
    }

}
