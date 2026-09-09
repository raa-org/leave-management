/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest'

/**
 * Smoke test that ships with the scaffold. Producer tasks will add real
 * coverage on top of this baseline (and switch to jsdom + Testing Library
 * where rendering is needed).
 */
describe('web toolchain smoke', () => {
  it('runs assertions', () => {
    expect(1 + 1).toBe(2)
  })
})
