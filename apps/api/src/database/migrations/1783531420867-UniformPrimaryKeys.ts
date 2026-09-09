import { MigrationInterface, QueryRunner } from "typeorm";

export class UniformPrimaryKeys1783531420867 implements MigrationInterface {
    name = 'UniformPrimaryKeys1783531420867'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "holidays" RENAME COLUMN "holidayId" TO "id"`);
        await queryRunner.query(`ALTER TABLE "holidays" RENAME CONSTRAINT "PK_49353757c7bd523a218c7d0e789" TO "PK_3646bdd4c3817d954d830881dfe"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" RENAME COLUMN "decisionId" TO "id"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" RENAME CONSTRAINT "PK_7830ec0c17fac973e076b57ca27" TO "PK_4e9217a8af7326be269751064ec"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" RENAME COLUMN "requestId" TO "id"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" RENAME CONSTRAINT "PK_2f7f8dcd4cebd0f0cd6a034911c" TO "PK_d3abcf9a16cef1450129e06fa9f"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME COLUMN "userId" TO "id"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME CONSTRAINT "PK_8bf09ba754322ab9c22a215c919" TO "PK_a3ffb1c0c8416b9fc6f907b7433"`);
        await queryRunner.query(`ALTER TABLE "countries" ADD "id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "PK_b47cbb5311bad9c9ae17b8c1eda"`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "PK_73995dfade6d6fa5a67bd27a863" PRIMARY KEY ("code", "id")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD "id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_0f69842491cdc23208d6698e0c5"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_ca1aa22c93a2b11c9f5f9b9cd9e" PRIMARY KEY ("leaveType", "userId", "id")`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD "id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_6327cc433074c3efddbe2ba390f"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_8e791f900124e3cef31d39dedbc" PRIMARY KEY ("roleName", "userId", "id")`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "PK_73995dfade6d6fa5a67bd27a863"`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "PK_b2d7006793e8697ab3ae2deff18" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "UQ_b47cbb5311bad9c9ae17b8c1eda" UNIQUE ("code")`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP CONSTRAINT "PK_3646bdd4c3817d954d830881dfe"`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD "id" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_ca1aa22c93a2b11c9f5f9b9cd9e"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_5ff822c06475ad54d36780b81e9" PRIMARY KEY ("leaveType", "id")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_5ff822c06475ad54d36780b81e9"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_a1d90dff48fb2bfd23a7163d077" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_8e791f900124e3cef31d39dedbc"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_18c24f2de056d2e8ee577de0870" PRIMARY KEY ("roleName", "id")`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_18c24f2de056d2e8ee577de0870"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_8acd5cf26ebd158416f477de799" PRIMARY KEY ("id")`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_balances_user_type" ON "leave_balances" ("userId", "leaveType") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_user_roles_user_role" ON "user_roles" ("userId", "roleName") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_user_roles_user_role"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_balances_user_type"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_8acd5cf26ebd158416f477de799"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_18c24f2de056d2e8ee577de0870" PRIMARY KEY ("roleName", "id")`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_18c24f2de056d2e8ee577de0870"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_8e791f900124e3cef31d39dedbc" PRIMARY KEY ("roleName", "userId", "id")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_a1d90dff48fb2bfd23a7163d077"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_5ff822c06475ad54d36780b81e9" PRIMARY KEY ("leaveType", "id")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_5ff822c06475ad54d36780b81e9"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_ca1aa22c93a2b11c9f5f9b9cd9e" PRIMARY KEY ("leaveType", "userId", "id")`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP CONSTRAINT "PK_3646bdd4c3817d954d830881dfe"`);
        await queryRunner.query(`ALTER TABLE "holidays" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD "id" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "holidays" ADD CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "UQ_b47cbb5311bad9c9ae17b8c1eda"`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "PK_b2d7006793e8697ab3ae2deff18"`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "PK_73995dfade6d6fa5a67bd27a863" PRIMARY KEY ("code", "id")`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "PK_8e791f900124e3cef31d39dedbc"`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "PK_6327cc433074c3efddbe2ba390f" PRIMARY KEY ("roleName", "userId")`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP CONSTRAINT "PK_ca1aa22c93a2b11c9f5f9b9cd9e"`);
        await queryRunner.query(`ALTER TABLE "leave_balances" ADD CONSTRAINT "PK_0f69842491cdc23208d6698e0c5" PRIMARY KEY ("leaveType", "userId")`);
        await queryRunner.query(`ALTER TABLE "leave_balances" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "countries" DROP CONSTRAINT "PK_73995dfade6d6fa5a67bd27a863"`);
        await queryRunner.query(`ALTER TABLE "countries" ADD CONSTRAINT "PK_b47cbb5311bad9c9ae17b8c1eda" PRIMARY KEY ("code")`);
        await queryRunner.query(`ALTER TABLE "countries" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" TO "PK_8bf09ba754322ab9c22a215c919"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME COLUMN "id" TO "userId"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" RENAME CONSTRAINT "PK_d3abcf9a16cef1450129e06fa9f" TO "PK_2f7f8dcd4cebd0f0cd6a034911c"`);
        await queryRunner.query(`ALTER TABLE "leave_requests" RENAME COLUMN "id" TO "requestId"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" RENAME CONSTRAINT "PK_4e9217a8af7326be269751064ec" TO "PK_7830ec0c17fac973e076b57ca27"`);
        await queryRunner.query(`ALTER TABLE "leave_approval_decisions" RENAME COLUMN "id" TO "decisionId"`);
        await queryRunner.query(`ALTER TABLE "holidays" RENAME CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" TO "PK_49353757c7bd523a218c7d0e789"`);
        await queryRunner.query(`ALTER TABLE "holidays" RENAME COLUMN "id" TO "holidayId"`);
    }

}
