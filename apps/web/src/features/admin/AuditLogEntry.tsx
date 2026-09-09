/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useState } from 'react'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import type { AdminAuditLogItemDto } from '@workspace/contracts'
import { AuditActionKind } from '@workspace/contracts'
import {
  formatAuditCategory,
  formatAuditEventType,
  formatAuditFieldName,
  formatAuditValue,
  formatDateTime,
  formatRoleName,
} from './admin-formatters'

type DiffRow = { field: string; before: unknown; after: unknown }

// The changed fields to display: prefer the server-computed diff, else derive
// from the before/after snapshots (a create has only after, a delete only
// before, and a no-op state change may have neither).
/** Exported for tests: the DOM-free rule behind what an entry expands to. */
export function buildDiffRows(item: AdminAuditLogItemDto): DiffRow[] {
  if (item.changedFields && item.changedFields.length > 0) {
    return item.changedFields
  }
  const before = item.before ?? null
  const after = item.after ?? null
  if (!before && !after) {
    return []
  }
  const keys = new Set([
    ...(before ? Object.keys(before) : []),
    ...(after ? Object.keys(after) : []),
  ])
  const rows = [...keys].map((field) => ({
    field,
    before: before ? before[field] : undefined,
    after: after ? after[field] : undefined,
  }))
  // With only one side there is nothing to compare, so a creation or a deletion
  // lists its whole snapshot. With BOTH sides this is an edit, and a field that
  // did not move is not part of it: listing them printed "25 -> 25" six times
  // for a save that changed nothing.
  return before && after
    ? rows.filter((row) => JSON.stringify(row.before) !== JSON.stringify(row.after))
    : rows
}

export function AuditLogEntry({ item }: { item: AdminAuditLogItemDto }) {
  const [expanded, setExpanded] = useState(false)

  const diffRows = buildDiffRows(item)
  // Snapshots alone are not a change. An update whose before and after match
  // used to offer "Show before / after" and then print every field as
  // "25 -> 25", which reads as a page of edits nobody made.
  const hasDetail = diffRows.length > 0
  const isCreate = item.action === AuditActionKind.Create
  const isDelete = item.action === AuditActionKind.Delete
  const showsTarget =
    Boolean(item.targetLabel) && item.targetUserId !== item.actorUserId

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '14px',
        p: '16px 18px',
      }}
    >
      <Stack spacing={1.1}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {/* Prototype .cat: the category stays PRIMARY blue even on the
                teal-accented admin surface, marking it as metadata not action. */}
            <Typography
              component="span"
              sx={{
                fontSize: 11,
                fontWeight: 700,
                px: '9px',
                py: '3px',
                borderRadius: '8px',
                border: '1px solid rgba(21, 94, 239, 0.3)',
                bgcolor: 'rgba(21, 94, 239, 0.05)',
                color: 'primary.main',
              }}
            >
              {formatAuditCategory(item.category)}
            </Typography>
            <Typography sx={{ fontSize: 15, fontWeight: 800 }}>
              {formatAuditEventType(item.eventType)}
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: 12, color: '#98a2b3', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {formatDateTime(item.occurredAt)}
          </Typography>
        </Stack>

        <Typography sx={{ fontSize: 13.5, color: 'text.secondary' }}>{item.summary}</Typography>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            By{' '}
            <Box component="strong" sx={{ color: 'text.primary', fontWeight: 700 }}>
              {item.actorLabel}
            </Box>
            {item.actorEmail ? ` (${item.actorEmail})` : ''}
          </Typography>
          {item.actorRoles.map((role) => (
            <RoleTag key={role} role={formatRoleName(role)} />
          ))}
          {showsTarget ? (
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
              · affecting{' '}
              <Box component="strong" sx={{ color: 'text.primary', fontWeight: 700 }}>
                {item.targetLabel}
              </Box>
            </Typography>
          ) : null}
        </Stack>

        {hasDetail ? (
          <>
            <Button
              size="small"
              variant="text"
              color="secondary"
              onClick={() => setExpanded((value) => !value)}
              startIcon={expanded ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
              sx={{ alignSelf: 'flex-start', fontWeight: 700 }}
            >
              {expanded
                ? 'Hide changes'
                : isCreate
                  ? 'Show created values'
                  : isDelete
                    ? 'Show removed values'
                    : 'Show before / after'}
            </Button>
            <Collapse in={expanded} unmountOnExit>
              <DiffTable rows={diffRows} isCreate={isCreate} isDelete={isDelete} />
            </Collapse>
          </>
        ) : null}
      </Stack>
    </Box>
  )
}

// Prototype .role pill; admin roles get the teal treatment via formatRoleName
// upstream is generic, so tint every role neutrally (the actor line already
// names them).
function RoleTag({ role }: { role: string }) {
  const isAdmin = role.toLowerCase().includes('admin')
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 10.5,
        fontWeight: 700,
        px: '8px',
        py: '2px',
        borderRadius: '999px',
        border: '1px solid',
        ...(isAdmin
          ? {
              color: 'secondary.main',
              borderColor: 'rgba(15, 118, 110, 0.35)',
              bgcolor: 'rgba(15, 118, 110, 0.1)',
            }
          : {
              color: 'text.secondary',
              borderColor: 'rgba(16, 24, 40, 0.14)',
            }),
      }}
    >
      {role}
    </Typography>
  )
}

function DiffTable({
  rows,
  isCreate,
  isDelete,
}: {
  rows: DiffRow[]
  isCreate: boolean
  isDelete: boolean
}) {
  if (rows.length === 0) {
    return (
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
        No field-level changes were recorded.
      </Typography>
    )
  }

  const headCellSx = {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: '#98a2b3',
    px: 1,
    py: 0.75,
  }

  return (
    <Box
      sx={{
        mt: 0.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '11px',
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ px: 0.5, bgcolor: 'rgba(16, 24, 40, 0.02)' }}>
        <Typography sx={{ ...headCellSx, flex: '0 0 32%' }}>Field</Typography>
        <Typography sx={{ ...headCellSx, flex: 1 }}>{isCreate ? 'Created value' : isDelete ? 'Removed value' : 'Before'}</Typography>
        {!isCreate && !isDelete ? (
          <Typography sx={{ ...headCellSx, flex: 1 }}>After</Typography>
        ) : null}
      </Stack>
      {rows.map((row, index) => (
        <Stack
          key={row.field}
          direction="row"
          spacing={1}
          sx={{
            px: 0.5,
            py: 0.9,
            alignItems: 'flex-start',
            borderTop: index > 0 ? '1px solid' : 'none',
            borderColor: 'divider',
          }}
        >
          <Typography sx={{ flex: '0 0 32%', px: 1, fontSize: 12.5, fontWeight: 700 }}>
            {formatAuditFieldName(row.field)}
          </Typography>
          {isCreate ? (
            <Typography sx={{ flex: 1, px: 1, fontSize: 12.5, fontWeight: 700, color: 'success.main', wordBreak: 'break-word' }}>
              {formatAuditValue(row.after)}
            </Typography>
          ) : isDelete ? (
            <Typography
              sx={{ flex: 1, px: 1, fontSize: 12.5, color: 'error.main', textDecoration: 'line-through', wordBreak: 'break-word' }}
            >
              {formatAuditValue(row.before)}
            </Typography>
          ) : (
            <>
              <Typography
                sx={{ flex: 1, px: 1, fontSize: 12.5, color: 'error.main', textDecoration: 'line-through', wordBreak: 'break-word' }}
              >
                {formatAuditValue(row.before)}
              </Typography>
              <Typography
                sx={{ flex: 1, px: 1, fontSize: 12.5, fontWeight: 700, color: 'success.main', wordBreak: 'break-word' }}
              >
                {formatAuditValue(row.after)}
              </Typography>
            </>
          )}
        </Stack>
      ))}
    </Box>
  )
}
