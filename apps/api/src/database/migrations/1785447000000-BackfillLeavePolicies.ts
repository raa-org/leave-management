import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * DATA MIGRATION (hand-written). The policy-engine cutover: mints the DEFAULT
 * policy from the live leave_settings defaults, one "Migrated {V}+{S}" policy
 * per distinct current-year allocation tuple (an admin override becomes a
 * one-member policy), enrolls every user into the policy matching their
 * current terms, stamps allocation provenance, and scrubs forward-booked
 * future-year rows. Memberships are backdated to Jan 1 of the cutover year —
 * the minted terms factually governed the whole year, and the resolver reads
 * the year at its first day, so anything later would silently re-term
 * veterans to DEFAULT on the first read.
 *
 * Because every minted policy carries a zero increment and terms equal to the
 * stored totalDays, the resolver reproduces the existing figures exactly: the
 * first post-cutover accrual pass posts ZERO adjustment rows (the acceptance
 * test proves it). One-shot and pre-go-live by design (the cutover year is
 * read from now()); idempotent via NOT EXISTS guards so a re-run changes
 * nothing.
 *
 * `import type` is deliberate: the class must be importable by the vitest
 * acceptance spec, and a value import of typeorm's interfaces does not
 * survive the Vite ESM transform.
 */
export class BackfillLeavePolicies1785447000000 implements MigrationInterface {
  name = 'BackfillLeavePolicies1785447000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. The DEFAULT policy, from the settings defaults (25/5 mirrors the
    // loadSettingsState fallback when the singleton row is absent). The
    // fingerprint is the same canonical string policyTermsFingerprint builds.
    await queryRunner.query(`
      INSERT INTO "leave_policies"
        ("id", "name", "description", "vacationDays", "sickDays",
         "vacationAnnualIncrement", "vacationIncrementCapDays",
         "probationMonths", "paidSickDuringProbation", "effectiveFrom",
         "effectiveTo", "isDefault", "termsFingerprint", "createdByUserId",
         "createdAt", "updatedAt")
      SELECT gen_random_uuid(), 'Default', 'Created by the engine cutover',
             d.v, d.s, 0, NULL, 0, false,
             make_date(date_part('year', now())::int, 1, 1), NULL, true,
             'v=' || to_char(d.v, 'FM999990.00') ||
             ';s=' || to_char(d.s, 'FM999990.00') ||
             ';vi=0.00;vc=none;p=0;ps=0',
             NULL, now(), now()
      FROM (
        SELECT round(COALESCE(s."defaultVacationDays", 25)::numeric, 2) AS v,
               round(COALESCE(s."defaultSickDays", 5)::numeric, 2) AS s
        FROM (SELECT 1) one
        LEFT JOIN "leave_settings" s ON s."id" = 1
      ) d
      WHERE NOT EXISTS (
        SELECT 1 FROM "leave_policies" WHERE "isDefault" = true
      )
    `)

    // 2. One "Migrated {V}+{S}" policy per distinct current-year terms tuple.
    // A user's tuple falls back to the settings defaults for a missing type;
    // the DEFAULT tuple is excluded automatically because its fingerprint
    // already exists (step 1).
    await queryRunner.query(`
      WITH cutover AS (SELECT date_part('year', now())::int AS year),
      defaults AS (
        SELECT round(COALESCE(s."defaultVacationDays", 25)::numeric, 2) AS v,
               round(COALESCE(s."defaultSickDays", 5)::numeric, 2) AS s
        FROM (SELECT 1) one
        LEFT JOIN "leave_settings" s ON s."id" = 1
      ),
      tuples AS (
        SELECT DISTINCT
          round(COALESCE(va."totalDays", d.v), 2) AS v,
          round(COALESCE(sa."totalDays", d.s), 2) AS s
        FROM "users" u
        CROSS JOIN defaults d
        CROSS JOIN cutover c
        LEFT JOIN "leave_allocations" va ON va."userId" = u."id"
          AND va."year" = c.year AND va."leaveType" = 'vacation'
        LEFT JOIN "leave_allocations" sa ON sa."userId" = u."id"
          AND sa."year" = c.year AND sa."leaveType" = 'sick'
      )
      INSERT INTO "leave_policies"
        ("id", "name", "description", "vacationDays", "sickDays",
         "vacationAnnualIncrement", "vacationIncrementCapDays",
         "probationMonths", "paidSickDuringProbation", "effectiveFrom",
         "effectiveTo", "isDefault", "termsFingerprint", "createdByUserId",
         "createdAt", "updatedAt")
      SELECT gen_random_uuid(),
             'Migrated ' ||
             regexp_replace(to_char(t.v, 'FM999990.00'), '\\.?0+$', '') ||
             '+' ||
             regexp_replace(to_char(t.s, 'FM999990.00'), '\\.?0+$', ''),
             'Created by the engine cutover', t.v, t.s, 0, NULL, 0, false,
             make_date(c.year, 1, 1), NULL, false,
             'v=' || to_char(t.v, 'FM999990.00') ||
             ';s=' || to_char(t.s, 'FM999990.00') ||
             ';vi=0.00;vc=none;p=0;ps=0',
             NULL, now(), now()
      FROM tuples t
      CROSS JOIN cutover c
      WHERE NOT EXISTS (
        SELECT 1 FROM "leave_policies" p
        WHERE p."termsFingerprint" =
          'v=' || to_char(t.v, 'FM999990.00') ||
          ';s=' || to_char(t.s, 'FM999990.00') ||
          ';vi=0.00;vc=none;p=0;ps=0'
      )
    `)

    // 3. Enroll every user without a live membership into the policy matching
    // their tuple, backdated to Jan 1 of the cutover year. The LATERAL pick is
    // deterministic when two policies happen to share a fingerprint (default
    // first, then oldest).
    await queryRunner.query(`
      WITH cutover AS (SELECT date_part('year', now())::int AS year),
      defaults AS (
        SELECT round(COALESCE(s."defaultVacationDays", 25)::numeric, 2) AS v,
               round(COALESCE(s."defaultSickDays", 5)::numeric, 2) AS s
        FROM (SELECT 1) one
        LEFT JOIN "leave_settings" s ON s."id" = 1
      ),
      user_tuples AS (
        SELECT u."id" AS user_id,
          round(COALESCE(va."totalDays", d.v), 2) AS v,
          round(COALESCE(sa."totalDays", d.s), 2) AS s
        FROM "users" u
        CROSS JOIN defaults d
        CROSS JOIN cutover c
        LEFT JOIN "leave_allocations" va ON va."userId" = u."id"
          AND va."year" = c.year AND va."leaveType" = 'vacation'
        LEFT JOIN "leave_allocations" sa ON sa."userId" = u."id"
          AND sa."year" = c.year AND sa."leaveType" = 'sick'
      )
      INSERT INTO "leave_policy_memberships"
        ("id", "userId", "policyId", "effectiveFrom", "effectiveTo",
         "supersededByRowId", "assignedByUserId", "note", "createdAt",
         "updatedAt")
      SELECT gen_random_uuid(), ut.user_id, p.id,
             make_date(c.year, 1, 1), NULL, NULL, NULL, 'Engine cutover',
             now(), now()
      FROM user_tuples ut
      CROSS JOIN cutover c
      CROSS JOIN LATERAL (
        SELECT lp."id"
        FROM "leave_policies" lp
        WHERE lp."termsFingerprint" =
          'v=' || to_char(ut.v, 'FM999990.00') ||
          ';s=' || to_char(ut.s, 'FM999990.00') ||
          ';vi=0.00;vc=none;p=0;ps=0'
        ORDER BY lp."isDefault" DESC, lp."createdAt" ASC
        LIMIT 1
      ) p
      WHERE NOT EXISTS (
        SELECT 1 FROM "leave_policy_memberships" m
        WHERE m."userId" = ut.user_id AND m."supersededByRowId" IS NULL
      )
    `)

    // 4. Provenance on the cutover year's open allocation rows.
    await queryRunner.query(`
      WITH cutover AS (SELECT date_part('year', now())::int AS year)
      UPDATE "leave_allocations" a
      SET "sourcePolicyId" = m."policyId", "updatedAt" = now()
      FROM "leave_policy_memberships" m, cutover c
      WHERE a."userId" = m."userId"
        AND m."supersededByRowId" IS NULL
        AND m."effectiveTo" IS NULL
        AND a."year" = c.year
        AND a."closedAt" IS NULL
        AND a."sourcePolicyId" IS NULL
    `)

    // 5. Forward-booked future years: scrub the unfinalized eager carryover
    // residue (a sick figure there even violates sick-never-carries) and
    // re-materialize totalDays from the enrolled policy. Future years carry no
    // accrual, so this is a plain cache update — no ledger rows.
    await queryRunner.query(`
      WITH cutover AS (SELECT date_part('year', now())::int AS year)
      UPDATE "leave_allocations" a
      SET "carriedOverDays" = CASE
            WHEN a."carryoverFinalized" = false THEN 0
            ELSE a."carriedOverDays"
          END,
          "totalDays" = CASE
            WHEN a."leaveType" = 'vacation' THEN p."vacationDays"
            ELSE p."sickDays"
          END,
          "sourcePolicyId" = p."id",
          "updatedAt" = now()
      FROM "leave_policy_memberships" m
      JOIN "leave_policies" p ON p."id" = m."policyId",
      cutover c
      WHERE a."userId" = m."userId"
        AND m."supersededByRowId" IS NULL
        AND m."effectiveTo" IS NULL
        AND a."year" > c.year
        AND a."closedAt" IS NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort inverse for a pre-go-live database: remove the cutover
    // memberships, clear the provenance stamps, and drop the minted policies
    // nothing references any more (FK RESTRICT protects surviving history).
    await queryRunner.query(`
      DELETE FROM "leave_policy_memberships" WHERE "note" = 'Engine cutover'
    `)
    await queryRunner.query(`
      UPDATE "leave_allocations" SET "sourcePolicyId" = NULL
      WHERE "sourcePolicyId" IN (
        SELECT "id" FROM "leave_policies"
        WHERE "createdByUserId" IS NULL
          AND ("name" = 'Default' OR "name" LIKE 'Migrated %')
      )
    `)
    await queryRunner.query(`
      DELETE FROM "leave_policies" p
      WHERE p."createdByUserId" IS NULL
        AND (p."name" = 'Default' OR p."name" LIKE 'Migrated %')
        AND NOT EXISTS (
          SELECT 1 FROM "leave_policy_memberships" m
          WHERE m."policyId" = p."id"
        )
    `)
  }
}
