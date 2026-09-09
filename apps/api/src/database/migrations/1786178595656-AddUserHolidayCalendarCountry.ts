import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddUserHolidayCalendarCountry1786178595656
  implements MigrationInterface
{
  name = 'AddUserHolidayCalendarCountry1786178595656'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "holidayCalendarCountryCode" character varying`,
    )
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_users_holiday_calendar_country" FOREIGN KEY ("holidayCalendarCountryCode") REFERENCES "countries"("code") ON DELETE SET NULL ON UPDATE NO ACTION`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_users_holiday_calendar_country"`,
    )
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "holidayCalendarCountryCode"`,
    )
  }
}
