/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useRef, useState } from 'react'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'

export type IdentifierItem = {
  label: string
  value: string
}

// Reusable "reveal + copy" affordance for raw system identifiers (UUIDs). They
// carry no glanceable meaning and only clutter a card, so they stay collapsed by
// default; an admin expands to read or copy an exact value when they genuinely
// need to cross-reference one. Revealed items flow inline and wrap so they use
// the available width instead of always stacking.
export function IdentifierDisclosure({
  items,
  showLabel = 'Show details',
  hideLabel = 'Hide details',
}: {
  items: IdentifierItem[]
  showLabel?: string
  hideLabel?: string
}) {
  const [open, setOpen] = useState(false)

  if (items.length === 0) {
    return null
  }

  return (
    <Box>
      <Button
        variant="text"
        size="small"
        color="inherit"
        onClick={() => setOpen((current) => !current)}
        startIcon={open ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
        aria-expanded={open}
        sx={{ minHeight: 0, py: 0.5, px: 1, color: 'text.secondary' }}
      >
        {open ? hideLabel : showLabel}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {items.map((item) => (
            <IdentifierRow key={item.label} item={item} />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

function IdentifierRow({ item }: { item: IdentifierItem }) {
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Cancel a pending "Copied" reset if the row unmounts mid-flash.
  useEffect(() => () => clearTimeout(resetRef.current), [])

  const copy = async () => {
    const ok = await copyText(item.value)
    if (!ok) {
      return
    }
    setCopied(true)
    clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopied(false), 1500)
  }

  const action = `Copy ${item.label.toLowerCase()}`

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ bgcolor: 'background.default', borderRadius: 2, px: 1.25, py: 0.5, minWidth: 0 }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ whiteSpace: 'nowrap' }}
      >
        {item.label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        {item.value}
      </Typography>
      <Tooltip title={copied ? 'Copied' : action}>
        <IconButton
          size="small"
          onClick={() => {
            void copy()
          }}
          aria-label={action}
          color={copied ? 'success' : 'default'}
        >
          {copied ? (
            <CheckRoundedIcon fontSize="inherit" />
          ) : (
            <ContentCopyRoundedIcon fontSize="inherit" />
          )}
        </IconButton>
      </Tooltip>
    </Stack>
  )
}

// Copy through the async Clipboard API, falling back to a hidden textarea for
// insecure contexts / older browsers where it is unavailable. Returns whether
// the write succeeded so the caller only flashes "Copied" on a real copy.
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fall through to the legacy path below
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
