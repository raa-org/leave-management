import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserCountryForeignKey1783680904334 implements MigrationInterface {
    name = 'AddUserCountryForeignKey1783680904334'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_a0ed47f0ee7de871cdbcf9d1f93"`);
    }

}
