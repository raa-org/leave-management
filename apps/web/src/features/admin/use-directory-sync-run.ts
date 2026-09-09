/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useRef, useState } from 'react'
import type { DirectorySyncResultDto } from '@workspace/contracts'
import type { AdminApiClient } from './admin-api'

export type DirectorySyncRun =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: DirectorySyncResultDto }
  | { status: 'error'; message: string }

/**
 * Owns one directory-sync pass on behalf of the page.
 *
 * Starting is only a no-op while a pass is in flight: a sync against an
 * unreachable directory takes as long as the connect timeout, so a button that
 * fired on every click would queue attempt after attempt against a server
 * already known to be down. Once a pass has finished, the button means what it
 * says and runs another.
 *
 * Starting is a user action, never an effect, so nothing here depends on how
 * many times React chooses to run an effect.
 */
export function useDirectorySyncRun(
  api: AdminApiClient,
  onFinished: (result: DirectorySyncResultDto | null) => void,
) {
  const [run, setRun] = useState<DirectorySyncRun>({ status: 'idle' })
  const inFlight = useRef(false)
  // Read at completion time, so a caller that rebuilds the callback on every
  // render cannot make this hook re-subscribe or report twice.
  const finished = useRef(onFinished)
  finished.current = onFinished

  const start = useCallback(() => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setRun({ status: 'running' })

    api.runDirectorySync().then(
      (result) => {
        inFlight.current = false
        setRun({ status: 'done', result })
        finished.current(result)
      },
      // Passed as the second handler rather than chained: a throw from the
      // success path is the caller's bug to surface, not a sync failure to
      // report twice.
      (error: unknown) => {
        inFlight.current = false
        setRun({
          status: 'error',
          // The API layer words every failure it can, so this stands in for one
          // case only: our own error body arriving with a blank message, which
          // that layer still passes through as worded. It must not claim the
          // run never started — the server may have accepted the POST and be
          // part-way through a pass right now.
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'The sync failed without a message. The audit log has the answer.',
        })
        finished.current(null)
      },
    )
  }, [api])

  // Clears a finished run's message from the page. Unreachable while a pass is
  // in flight — the alert this dismisses only exists once the run has settled.
  const dismiss = useCallback(() => {
    setRun({ status: 'idle' })
  }, [])

  return { run, start, dismiss }
}
