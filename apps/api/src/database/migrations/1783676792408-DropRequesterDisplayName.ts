import { MigrationInterface, QueryRunner } from "typeorm";

export class DropRequesterDisplayName1783676792408 implements MigrationInterface {
    name = 'DropRequesterDisplayName1783676792408'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP COLUMN "requesterDisplayName"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD "requesterDisplayName" character varying NOT NULL`);
    }

}
