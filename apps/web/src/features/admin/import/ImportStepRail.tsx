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
import type { RailStepModel, WizardStep } from './import-wizard-model'

/**
 * The wizard's left rail (prototype .rail): four steps, an index ring that
 * fills teal with a check once the step is behind the operator, and a caption
 * that carries the step's live outcome. Purely presentational: the captions
 * and clickability arrive precomputed from import-wizard-model, so this file
 * owns nothing but markup.
 */
export function ImportStepRail({
  steps,
  onSelect,
  showStartOver,
  startOverDisabled,
  onStartOver,
}: {
  steps: RailStepModel[]
  onSelect: (step: WizardStep) => void
  showStartOver: boolean
  startOverDisabled: boolean
  onStartOver: () => void
}) {
  return (
    <Stack
      spacing={0.75}
      sx={{
        // Sticky beside the tall main column on desktop; a horizontal strip
        // above it on narrow screens (prototype's max-width:900px block).
        position: { xs: 'static', md: 'sticky' },
        top: { md: 88 },
      }}
    >
      <Stack
        component="nav"
        aria-label="Import steps"
        direction={{ xs: 'row', md: 'column' }}
        spacing={0.5}
        sx={{ overflowX: { xs: 'auto', md: 'visible' }, pb: { xs: 0.5, md: 0 } }}
      >
        {steps.map((item) => (
          <ButtonBase
            key={item.step}
            onClick={() => onSelect(item.step)}
            disabled={!item.clickable}
            aria-current={item.state === 'current' ? 'step' : undefined}
            sx={(theme) => ({
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'flex-start',
              textAlign: 'left',
              gap: 1.25,
              width: { xs: 'auto', md: '100%' },
              minWidth: { xs: 168, md: 0 },
              px: 1.25,
              py: 1.25,
              borderRadius: '12px',
              bgcolor:
                item.state === 'current'
                  ? alpha(theme.palette.secondary.main, 0.1)
                  : 'transparent',
              '&:hover': item.clickable
                ? { bgcolor: alpha(theme.palette.text.primary, 0.045) }
                : undefined,
            })}
          >
            <Box
              aria-hidden
              sx={(theme) => ({
                width: 26,
                height: 26,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                fontSize: '12px',
                // Medium, not bold: a lone digit in a ring next to 800-weight
                // titles reads as shouting at anything heavier (owner's call).
                fontWeight: 500,
                border: '1.5px solid',
                ...(item.state === 'done'
                  ? {
                      bgcolor: 'secondary.main',
                      borderColor: 'secondary.main',
                      color: '#fff',
                    }
                  : item.state === 'current'
                    ? {
                        bgcolor: 'background.paper',
                        borderColor: 'secondary.main',
                        color: 'secondary.main',
                      }
                    : {
                        bgcolor: 'background.paper',
                        borderColor: theme.palette.divider,
                        color: 'text.secondary',
                      }),
              })}
            >
              {item.state === 'done' ? <CheckGlyph size={11} /> : item.step}
            </Box>
            <Stack spacing={0.25} sx={{ minWidth: 0 }}>
              <Typography
                sx={{
                  fontSize: '13.5px',
                  fontWeight: 800,
                  lineHeight: 1.3,
                  color:
                    item.state === 'current'
                      ? 'secondary.main'
                      : item.state === 'future'
                        ? 'text.disabled'
                        : 'text.secondary',
                }}
              >
                {item.title}
              </Typography>
              <Typography
                sx={{
                  fontSize: '11.5px',
                  color: 'text.disabled',
                  lineHeight: 1.4,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {item.caption}
              </Typography>
            </Stack>
          </ButtonBase>
        ))}
      </Stack>
      {showStartOver ? (
        <ButtonBase
          onClick={onStartOver}
          disabled={startOverDisabled}
          sx={(theme) => ({
            alignSelf: 'flex-start',
            fontSize: '12px',
            fontWeight: 700,
            color: 'text.disabled',
            px: 1.25,
            py: 0.75,
            borderRadius: '8px',
            '&:hover': {
              color: 'error.main',
              bgcolor: alpha(theme.palette.error.main, 0.08),
            },
          })}
        >
          Start over
        </ButtonBase>
      ) : null}
    </Stack>
  )
}
