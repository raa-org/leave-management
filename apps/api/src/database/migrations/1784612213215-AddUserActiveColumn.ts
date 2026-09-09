import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserActiveColumn1784612213215 implements MigrationInterface {
    name = 'AddUserActiveColumn1784612213215'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Soft-delete flag for the LDAP sync: users who disappear from the
        // directory are deactivated, never deleted (leave requests, balances
        // and audit rows reference them). DEFAULT true marks every existing
        // row as active.
        await queryRunner.query(`ALTER TABLE "users" ADD "active" boolean NOT NULL DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "active"`);
    }

}
