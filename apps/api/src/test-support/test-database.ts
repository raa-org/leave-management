/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

// Loads .env / .env.<APP_ENV> so DB_HOST/DB_USER/DB_PASSWORD are available, then
// points a DataSource at the dedicated test database instead of the app one.
import '../load-env'
import { DataSource, type DataSourceOptions } from 'typeorm'
import { dataSourceOptions } from '../database/data-source'

const TEST_DATABASE = process.env['DB_NAME_TEST'] ?? 'leave_management_test'

// Shared options for the test database: same entities as the app, schema built
// from them via `synchronize` (see createTestDataSource for why not migrations).
// Used both to create a standalone DataSource and by TypeOrmModule.forRoot in
// the Nest-app integration spec.
//
// `dropSchema` rebuilds the schema from scratch on every initialize() so a
// schema change (e.g. a new NOT NULL column) can never fail to reconcile
// against leftover rows from a previous run. Safe because api specs run
// serially (vitest `fileParallelism: false`) against this shared database.
export const testDataSourceOptions = {
  ...dataSourceOptions,
  database: TEST_DATABASE,
  migrations: [],
  dropSchema: true,
  synchronize: true,
} as DataSourceOptions

export function createTestDataSource(): DataSource {
  // Build the test schema from the entities via `synchronize` rather than the
  // migration files: vitest's Vite ESM transform cannot load the generated
  // migration's type-only `import { MigrationInterface }` from typeorm's CJS
  // build. The migrations themselves are validated by `npm run migration:run`
  // against the real database; `synchronize` derives the same schema from the
  // same entities, which is what these logic tests need.
  return new DataSource(testDataSourceOptions)
}

/** Create the test DataSource and build its schema (once per spec file). */
export async function initTestDataSource(): Promise<DataSource> {
  const dataSource = createTestDataSource()
  await dataSource.initialize()
  return dataSource
}

/** Reset every table between tests for isolation. */
export async function truncateAll(dataSource: DataSource): Promise<void> {
  const tables = dataSource.entityMetadatas
    .map((metadata) => `"${metadata.tableName}"`)
    .join(', ')
  if (tables.length > 0) {
    await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`)
  }
}
