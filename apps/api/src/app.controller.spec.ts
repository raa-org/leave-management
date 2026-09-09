/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'
import { AppController } from './app.controller'

/**
 * Smoke test that ships with the scaffold. Confirms vitest + tsc are
 * wired correctly. Producer-generated tasks will add real coverage on
 * top of this baseline.
 */
describe('AppController smoke', () => {
  it('can be instantiated', () => {
    const controller = new AppController()
    expect(controller).toBeInstanceOf(AppController)
  })

  it('health reports ok with a stable ISO start time', () => {
    const controller = new AppController()

    const first = controller.health()
    expect(first.status).toBe('ok')
    expect(Number.isNaN(Date.parse(first.startedAt))).toBe(false)
    expect(new Date(first.startedAt).toISOString()).toBe(first.startedAt)

    const second = controller.health()
    expect(second.startedAt).toBe(first.startedAt)
  })
})
