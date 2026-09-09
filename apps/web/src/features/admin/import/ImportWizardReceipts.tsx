/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import { CheckGlyph } from '../../employee/employee-ui'
import type { ReceiptModel, WizardStep } from './import-wizard-model'

/**
 * Committed steps collapsed to one-line receipts above the active card
 * (prototype .receipts): a teal check, the step's outcome in one line, and a
 * Change link that walks back. The texts arrive precomputed from
 * import-wizard-model so the wording is covered by node tests.
 */
export function ImportWizardReceipts({
  receipts,
  busy,
  onChange,
}: {
  receipts: ReceiptModel[]
  busy: boolean
  onChange: (step: WizardStep) => void
}) {
  if (receipts.length === 0) {
    return null
  }
  return (
    <Stack spacing={1}>
      {receipts.map((receipt) => (
        <Stack
          key={receipt.step}
          direction="row"
          spacing={1.25}
          alignItems="center"
          sx={(theme) => ({
            border: `1px solid ${theme.palette.divider}`,
            bgcolor: 'background.paper',
            borderRadius: '12px',
            px: 1.75,
            py: 1,
            boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
          })}
        >
          <Box
            aria-hidden
            sx={(theme) => ({
              width: 20,
              height: 20,
              borderRadius: '50%',
              flexShrink: 0,
              display: 'grid',
              placeItems: 'center',
              bgcolor: alpha(theme.palette.secondary.main, 0.1),
              color: 'secondary.main',
            })}
          >
            <CheckGlyph size={11} />
          </Box>
          <Typography
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: '12.5px',
              fontWeight: 600,
              color: 'text.secondary',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {receipt.text}
          </Typography>
          <ButtonBase
            onClick={() => onChange(receipt.step)}
            disabled={busy}
            sx={(theme) => ({
              flexShrink: 0,
              fontSize: '12px',
              fontWeight: 700,
              color: busy ? 'text.disabled' : 'secondary.main',
              px: 1.25,
              py: 0.5,
              borderRadius: '8px',
              '&:hover': {
                bgcolor: alpha(theme.palette.secondary.main, 0.1),
              },
            })}
          >
            Change
          </ButtonBase>
        </Stack>
      ))}
    </Stack>
  )
}
