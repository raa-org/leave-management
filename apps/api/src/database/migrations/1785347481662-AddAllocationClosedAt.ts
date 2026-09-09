import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAllocationClosedAt1785347481662 implements MigrationInterface {
    name = 'AddAllocationClosedAt1785347481662'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD "closedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP COLUMN "closedAt"`);
    }

}
