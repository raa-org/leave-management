/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'

// A small "(i)" affordance that reveals an explanation on hover/focus/tap. Used
// to make the leave logic transparent to both employees and administrators.
export function InfoHint({
  title,
  label = 'More information',
}: {
  title: ReactNode
  label?: string
}) {
  return (
    <Tooltip
      title={<Box sx={{ py: 0.25, maxWidth: 260, lineHeight: 1.5 }}>{title}</Box>}
      arrow
      enterTouchDelay={0}
      leaveTouchDelay={4000}
    >
      <InfoOutlinedIcon
        role="img"
        aria-label={label}
        tabIndex={0}
        sx={{
          fontSize: 15,
          color: 'text.disabled',
          cursor: 'help',
          verticalAlign: 'middle',
          borderRadius: '50%',
          transition: 'color 150ms ease',
          '&:hover, &:focus-visible': { color: 'text.secondary' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 },
        }}
      />
    </Tooltip>
  )
}
