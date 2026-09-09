import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationActorLabel1784533595575 implements MigrationInterface {
    name = 'AddNotificationActorLabel1784533595575'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" ADD "actorLabel" character varying NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "actorLabel"`);
    }

}
