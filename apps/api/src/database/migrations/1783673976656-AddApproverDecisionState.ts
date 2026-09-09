import { MigrationInterface, QueryRunner } from "typeorm";

export class AddApproverDecisionState1783673976656 implements MigrationInterface {
    name = 'AddApproverDecisionState1783673976656'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD "decision" character varying NOT NULL DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD "decidedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD "decisionComment" character varying`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD "actorUserId" uuid`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP COLUMN "actorUserId"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP COLUMN "decisionComment"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP COLUMN "decidedAt"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP COLUMN "decision"`);
    }

}
