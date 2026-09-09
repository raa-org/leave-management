import { MigrationInterface, QueryRunner } from "typeorm";

export class AddForeignKeysToExistingTables1783611922490 implements MigrationInterface {
    name = 'AddForeignKeysToExistingTables1783611922490'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "leave_requests" ADD CONSTRAINT "FK_ccf03ef9ce51273f64eaef3e7ac" FOREIGN KEY ("requesterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" ADD CONSTRAINT "FK_0bc4d920fb3de2730e1327b866d" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "FK_aae940169a5f4c5df2c79d0e080" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" ADD CONSTRAINT "FK_1865db77a6240984d05e60211ae" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" ADD CONSTRAINT "FK_943e3073dded29faac709c55fbc" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" ADD CONSTRAINT "FK_fe6a0fc72e4d6b4704f266cf408" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "FK_472b25323af01488f1f66a06b67" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notification_deliveries" ADD CONSTRAINT "FK_73495b72b8069ba0a85a0b45c13" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_deliveries" DROP CONSTRAINT "FK_73495b72b8069ba0a85a0b45c13"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "FK_472b25323af01488f1f66a06b67"`);
        await queryRunner.query(`ALTER TABLE "leave_request_approvers" DROP CONSTRAINT "FK_fe6a0fc72e4d6b4704f266cf408"`);
        await queryRunner.query(`ALTER TABLE "leave_request_activities" DROP CONSTRAINT "FK_943e3073dded29faac709c55fbc"`);
        await queryRunner.query(`ALTER TABLE "leave_balance_changes" DROP CONSTRAINT "FK_1865db77a6240984d05e60211ae"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "FK_aae940169a5f4c5df2c79d0e080"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" DROP CONSTRAINT "FK_0bc4d920fb3de2730e1327b866d"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" DROP CONSTRAINT "FK_ccf03ef9ce51273f64eaef3e7ac"`);
    }

}
