import { MigrationInterface, QueryRunner } from "typeorm";

export class DropActorNameSnapshots1783677144696 implements MigrationInterface {
    name = 'DropActorNameSnapshots1783677144696'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_activities" RENAME COLUMN "actorDisplayName" TO "systemActorLabel"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" DROP COLUMN "actorDisplayName"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ALTER COLUMN "systemActorLabel" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ALTER COLUMN "systemActorLabel" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ADD "actorDisplayName" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" RENAME COLUMN "systemActorLabel" TO "actorDisplayName"`);
    }

}
