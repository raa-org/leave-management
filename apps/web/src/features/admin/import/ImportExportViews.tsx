/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import { adminApi, type AdminApiClient } from '../admin-api'
import { ExportCard } from './ExportCard'
import { ImportWizard } from './ImportWizard'

/**
 * The Import and Export Settings tabs share this one mount. They are separate
 * entries in the tab strip (the owner's call: no sub-toggle), but the wizard
 * must survive a glance at Export mid-run — its whole run lives in component
 * state — so both stay rendered and the inactive one is display:none'd.
 * Crossing to Policies or Calendars unmounts the pair like any other tab
 * switch; that is the same trade every settings tab makes with its drafts.
 *
 * data-active-view exists for the node tests: with both subtrees present in
 * static markup, content strings alone cannot prove which view is on screen.
 */
export function ImportExportViews({
  api = adminApi,
  active,
}: {
  api?: AdminApiClient
  active: 'import' | 'export'
}) {
  return (
    <Box data-active-view={active}>
      <Box sx={{ display: active === 'import' ? 'block' : 'none' }}>
        <ImportWizard api={api} />
      </Box>
      <Box sx={{ display: active === 'export' ? 'block' : 'none' }}>
        <ExportCard api={api} />
      </Box>
    </Box>
  )
}
