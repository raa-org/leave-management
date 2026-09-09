import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCarryoverCapPercentOfTotal1785914244229 implements MigrationInterface {
    name = 'AddCarryoverCapPercentOfTotal1785914244229'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."leave_settings_carryovercapmode_enum" RENAME TO "leave_settings_carryovercapmode_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."leave_settings_carryovercapmode_enum" AS ENUM('days', 'percent', 'percent_of_total')`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" TYPE "public"."leave_settings_carryovercapmode_enum" USING "carryoverCapMode"::"text"::"public"."leave_settings_carryovercapmode_enum"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" SET DEFAULT 'percent'`);
        await queryRunner.query(`DROP TYPE "public"."leave_settings_carryovercapmode_enum_old"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."leave_settings_carryovercapmode_enum_old" AS ENUM('days', 'percent')`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" TYPE "public"."leave_settings_carryovercapmode_enum_old" USING "carryoverCapMode"::"text"::"public"."leave_settings_carryovercapmode_enum_old"`);
        await queryRunner.query(`ALTER TABLE "leave_settings" ALTER COLUMN "carryoverCapMode" SET DEFAULT 'percent'`);
        await queryRunner.query(`DROP TYPE "public"."leave_settings_carryovercapmode_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."leave_settings_carryovercapmode_enum_old" RENAME TO "leave_settings_carryovercapmode_enum"`);
    }

}
