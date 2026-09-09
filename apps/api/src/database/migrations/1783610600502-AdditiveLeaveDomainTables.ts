import { MigrationInterface, QueryRunner } from "typeorm";

export class AdditiveLeaveDomainTables1783610600502 implements MigrationInterface {
    name = 'AdditiveLeaveDomainTables1783610600502'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "holiday_calendars" ("id" uuid NOT NULL, "countryCode" character varying NOT NULL, "year" integer NOT NULL, "name" character varying, "sourceCalendarId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_e600f14506faa4edb8be8c40b12" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_holiday_calendars_country_year" ON "holiday_calendars" ("countryCode", "year") `);
        await queryRunner.query(`CREATE TABLE "leave_allocations" ("id" uuid NOT NULL, "userId" uuid NOT NULL, "year" integer NOT NULL, "leaveType" character varying NOT NULL, "totalDays" numeric(6,2) NOT NULL, "carriedOverDays" numeric(6,2) NOT NULL DEFAULT '0', "accrualStartDate" date, "setByUserId" uuid, "note" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_d6f97727d0437c65c1e0d73f7a0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_leave_allocations_user_year_type" ON "leave_allocations" ("userId", "year", "leaveType") `);
        await queryRunner.query(`CREATE TABLE "projects" ("id" uuid NOT NULL, "externalId" character varying NOT NULL, "key" character varying, "name" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_projects_external" ON "projects" ("externalId") `);
        await queryRunner.query(`CREATE TABLE "user_project_memberships" ("id" uuid NOT NULL, "userId" uuid NOT NULL, "projectId" uuid NOT NULL, "roleOnProject" character varying NOT NULL, "approverEligible" boolean NOT NULL DEFAULT false, "assignedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_e1720b25c7e84a33ccc6f90662c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_user_project_memberships_project" ON "user_project_memberships" ("projectId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_user_project_memberships_user_project" ON "user_project_memberships" ("userId", "projectId") `);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_521adef4062ef84ff39490f1a91" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" ADD CONSTRAINT "FK_fd077f9cfc97d4a6703027c5c5d" FOREIGN KEY ("sourceCalendarId") REFERENCES "holiday_calendars"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD CONSTRAINT "FK_a5fc48d6b3e7b39bbd2376a8aeb" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" ADD CONSTRAINT "FK_6b3bac3a86087b3e14434956685" FOREIGN KEY ("setByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_project_memberships" ADD CONSTRAINT "FK_bdd0b584a79a5252889dbeb14fb" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_project_memberships" ADD CONSTRAINT "FK_3678bdfa7f7d854c23cd084ae1b" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_project_memberships" DROP CONSTRAINT "FK_3678bdfa7f7d854c23cd084ae1b"`);
        await queryRunner.query(`ALTER TABLE "user_project_memberships" DROP CONSTRAINT "FK_bdd0b584a79a5252889dbeb14fb"`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP CONSTRAINT "FK_6b3bac3a86087b3e14434956685"`);
        await queryRunner.query(`ALTER TABLE "leave_allocations" DROP CONSTRAINT "FK_a5fc48d6b3e7b39bbd2376a8aeb"`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_fd077f9cfc97d4a6703027c5c5d"`);
        await queryRunner.query(`ALTER TABLE "holiday_calendars" DROP CONSTRAINT "FK_521adef4062ef84ff39490f1a91"`);
        await queryRunner.query(`DROP INDEX "public"."uq_user_project_memberships_user_project"`);
        await queryRunner.query(`DROP INDEX "public"."idx_user_project_memberships_project"`);
        await queryRunner.query(`DROP TABLE "user_project_memberships"`);
        await queryRunner.query(`DROP INDEX "public"."uq_projects_external"`);
        await queryRunner.query(`DROP TABLE "projects"`);
        await queryRunner.query(`DROP INDEX "public"."uq_leave_allocations_user_year_type"`);
        await queryRunner.query(`DROP TABLE "leave_allocations"`);
        await queryRunner.query(`DROP INDEX "public"."uq_holiday_calendars_country_year"`);
        await queryRunner.query(`DROP TABLE "holiday_calendars"`);
    }

}
