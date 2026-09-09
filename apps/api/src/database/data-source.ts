/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import 'reflect-metadata'
// Load .env / .env.<APP_ENV> from the workspace root so the standalone TypeORM
// CLI gets the same DB_* values as the Nest app. Must stay above the config.
import '../load-env'
import { join } from 'node:path'
import { DataSource, type DataSourceOptions } from 'typeorm'
import { entities } from './entities'

const parsedPort = Number(process.env['DB_PORT'] ?? 5432)

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env['DB_HOST'] ?? '127.0.0.1',
  port: Number.isNaN(parsedPort) ? 5432 : parsedPort,
  username: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? '',
  database: process.env['DB_NAME'] ?? 'leave_management',
  entities,
  // Generated migrations compile flat into dist/database/migrations next to
  // this file; the glob matches both the .ts (ts-node CLI) and .js (runtime).
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  // Schema is only ever changed through generated migrations.
  synchronize: false,
  logging: process.env['DB_LOGGING'] === 'true',
}

// The TypeORM CLI (`-d data-source.ts`) requires exactly one exported
// DataSource instance, so this is the only DataSource export in the module.
export const AppDataSource = new DataSource(dataSourceOptions)
