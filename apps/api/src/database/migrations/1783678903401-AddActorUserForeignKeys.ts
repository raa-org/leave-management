import { MigrationInterface, QueryRunner } from "typeorm";

export class AddActorUserForeignKeys1783678903401 implements MigrationInterface {
    name = 'AddActorUserForeignKeys1783678903401'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ALTER COLUMN "actorUserId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ADD CONSTRAINT "FK_0e6f7d5eff32011c72948940ad4" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ADD CONSTRAINT "FK_5bb201a7fe3d238b440222d6282" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "FK_5e95ae3a83164c5c0a7ee6e1e97" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP CONSTRAINT "FK_5e95ae3a83164c5c0a7ee6e1e97"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" DROP CONSTRAINT "FK_5bb201a7fe3d238b440222d6282"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" DROP CONSTRAINT "FK_0e6f7d5eff32011c72948940ad4"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ALTER COLUMN "actorUserId" SET NOT NULL`);
    }

}
