/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { DataSource } from 'typeorm'
import { ProjectEntity } from '../domain/entities/project.entity'
import { UserProjectMembershipEntity } from '../domain/entities/user-project-membership.entity'
import { testUuid } from './test-ids'

// Projects and their memberships are mirrored from OIDC at login, so no domain
// service writes them — specs that need the employee directory's project
// projection/filter seed the two tables directly.
//
// Ids are derived from the slug via testUuid, so a spec can reference the same
// project it seeded (`testUuid('project-apollo')`) without threading the
// returned id around.

export function testProjectId(slug: string): string {
  return testUuid(`project-${slug}`)
}

export async function seedProject(
  dataSource: DataSource,
  slug: string,
  name: string,
): Promise<string> {
  const id = testProjectId(slug)
  await dataSource.getRepository(ProjectEntity).save({
    id,
    externalId: `external-${slug}`,
    key: slug,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  return id
}

// `userSeed` is the label the user was created with (testUuid('proj-anna')),
// `projectSlug` the one passed to seedProject.
export async function seedMembership(
  dataSource: DataSource,
  userSeed: string,
  projectSlug: string,
): Promise<void> {
  await dataSource.getRepository(UserProjectMembershipEntity).save({
    id: testUuid(`membership-${userSeed}-${projectSlug}`),
    userId: testUuid(userSeed),
    projectId: testProjectId(projectSlug),
    roleOnProject: 'member',
    approverEligible: false,
    assignedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}
