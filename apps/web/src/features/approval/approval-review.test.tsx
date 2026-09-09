/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { LeaveRequestDetailDto } from '@workspace/contracts'
import {
  ApproverDecision,
  ApproverKind,
  LeaveApprovalAction,
  LeaveBalanceChangeReason,
  LeaveRequestStatus,
  LeaveRequestViewerStanding,
  LeaveType,
} from '@workspace/contracts'
import { apiUrl } from '../../lib/api-url'
import {
  configureWorkdayHours,
  formatDayMonth,
  formatWeekdayDayMonth,
} from '../../lib/leave-format'
import { ApprovalReviewPage } from './ApprovalReviewPage'
import {
  fetchApprovalReviewRequest,
  submitApprovalReviewDecision,
} from './approvalReview.api'
import {
  approvalReviewActions,
  approvalReviewReducer,
  createInitialApprovalReviewState,
} from './approvalReview.slice'

describe('approval review feature', () => {
  it('loads approval request details through the mounted api url', async () => {
    const request = createRequest()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(request), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    )

    const result = await fetchApprovalReviewRequest(
      request.requestId,
      fetchImpl as typeof fetch,
    )

    expect(result).toEqual(request)
    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl(`/api/leave-requests/${request.requestId}`),
      expect.objectContaining({
        headers: expect.objectContaining({ accept: 'application/json' }),
      }),
    )
  })

  it('submits approval decisions with comment payloads', async () => {
    const request = createRequest()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...request, status: LeaveRequestStatus.Approved }), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    )

    await submitApprovalReviewDecision(
      request.requestId,
      {
        action: LeaveApprovalAction.Approve,
        comment: 'Looks good',
      },
      fetchImpl as typeof fetch,
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      apiUrl(`/api/leave-requests/${request.requestId}/approval`),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: LeaveApprovalAction.Approve,
          comment: 'Looks good',
        }),
      }),
    )
  })

  it('tracks load and submit transitions in the dedicated slice', () => {
    const request = createRequest()

    const loadingState = approvalReviewReducer(
      createInitialApprovalReviewState({ requestId: request.requestId }),
      approvalReviewActions.approvalReviewLoadStarted(request.requestId),
    )

    const readyState = approvalReviewReducer(
      loadingState,
      approvalReviewActions.approvalReviewLoadSucceeded(request),
    )

    const commentState = approvalReviewReducer(
      readyState,
      approvalReviewActions.approvalReviewCommentChanged('Approved for staffing coverage.'),
    )

    const submittingState = approvalReviewReducer(
      commentState,
      approvalReviewActions.approvalReviewSubmitStarted(
        LeaveApprovalAction.Approve,
      ),
    )

    const approvedState = approvalReviewReducer(
      submittingState,
      approvalReviewActions.approvalReviewSubmitSucceeded({
        ...request,
        status: LeaveRequestStatus.Approved,
        decisionComment: 'Approved for staffing coverage.',
        decidedAt: '2026-06-03T09:15:00.000Z',
      }),
    )

    expect(readyState.loadStatus).toBe('ready')
    expect(commentState.draftComment).toBe('Approved for staffing coverage.')
    expect(
      submittingState.submitStates[LeaveApprovalAction.Approve].status,
    ).toBe('submitting')
    expect(approvedState.request?.status).toBe(LeaveRequestStatus.Approved)
    expect(approvedState.draftComment).toBe('Approved for staffing coverage.')
  })

  it('renders the review surface with request context and actions', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    expect(markup).toContain('Approval review')
    expect(markup).toContain('href="/employee/dashboard"')
    expect(markup).toContain('href="/employee/history"')
    expect(markup).toContain('MuiBottomNavigation-root')
    expect(markup).toContain('Alex Employee')
    expect(markup).toContain('Approve request')
    expect(markup).toContain('Reject request')
    expect(markup).toContain('manager@example.com')
    // Redesigned surface: the requester's own note (distinct from the activity
    // comment) gives the approver context, the routing shows per-approver
    // decision pills, and the balance impact renders the status-derived rows.
    expect(markup).toContain('“Family travel”')
    expect(markup).toContain('Two weeks with family')
    expect(markup).toContain('routing-manager@example.com')
    expect(markup).toContain('awaiting decision')
    expect(markup).toContain('Placed on hold')
    // Standalone shell status pill: pending -> "Submitted …", never "Decided".
    expect(markup).toContain('Submitted ')
    expect(markup).not.toContain('Decided ')
  })

  it('tells the approver how much of the leave they are signing off is unpaid', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            paidDays: 2,
            unpaidDays: 1,
            heldDays: 2,
            unpaidDates: ['2026-06-12'],
          }}
        />
      </StaticRouter>,
    )

    // The headline figure carries the split, so an approver cannot read the
    // request as three paid days.
    expect(markup).toContain('3d (2d paid + 1d unpaid)')
    // And the balance impact holds only the days that actually move it.
    expect(markup).toContain('Unpaid days')
    expect(markup).toContain('never held, never spent')
  })


  it('renders the administrator workspace nav when opened from admin routes', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/admin/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    expect(markup).toContain('Administrator workspace')
    expect(markup).toContain('href="/admin/activity"')
    expect(markup).toContain('href="/admin/employees"')
    expect(markup).not.toContain('href="/employee/dashboard"')
  })

  it('states the all-approvers gate and its progress above the decision buttons', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    // One of the two 'to' approvers has approved; the cc recipient never votes
    // and must not be counted. The header tile shows the capital-A gate label.
    expect(markup).toContain('Approved by 1 of 2 approvers')
    // The gate BOX renders the reworded lead + the lowercase progress form.
    // Pin both so a reintroduced em-dash or a changed lead is caught.
    expect(markup).toContain('Every listed approver must approve before this request is')
    expect(markup).toContain('approved by 1 of 2 approvers so far. A single rejection rejects the whole request.')
    expect(markup).not.toContain('—')
  })

  it('falls back to "Awaiting reviewer action" when there are no primary approvers', () => {
    const ccOnly: LeaveRequestDetailDto = {
      ...createRequest(),
      approvers: [{ email: 'hr@example.com', kind: ApproverKind.Cc }],
    }
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={ccOnly} />
      </StaticRouter>,
    )

    // gate.total === 0 -> the Decision tile shows the positive fallback.
    expect(markup).toContain('Awaiting reviewer action')
  })

  it('reports gate progress instead of a decision timestamp while still pending', () => {
    const pending = createRequest()
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={pending} />
      </StaticRouter>,
    )

    expect(pending.decidedAt).toBeUndefined()
    // Without this the metric would read "Awaiting reviewer action" even though
    // a reviewer has already acted.
    expect(markup).not.toContain('Awaiting reviewer action')
  })

  it('shows the recorded decision instead of the form once settled', () => {
    const approved = {
      ...createRequest(),
      status: LeaveRequestStatus.Approved,
      decidedAt: '2026-06-03T10:00:00.000Z',
      decisionComment: 'Approved for staffing coverage.',
    }
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={approved} />
      </StaticRouter>,
    )

    // The decision banner carries the recorded note; the approve/reject form
    // and its gate copy are gone.
    expect(markup).toContain('Approved for staffing coverage.')
    expect(markup).not.toContain('Approve request')
    expect(markup).not.toContain('A single rejection rejects the whole request')
    // Decided branches: the tile shows "Updated …", the status pill "Decided …".
    expect(markup).toContain('Updated ')
    expect(markup).toContain('Decided ')
    // The shared balance snapshot (net-of-holds bookable) renders type-neutral,
    // not the employee-page's "Your …" phrasing.
    expect(markup).toContain('Vacation balance after this request:')
    expect(markup).not.toContain('Your vacation balance now')
  })

  // The emailed link is identical for every recipient, so the page must take the
  // server's word for who may act. Before this, any viewer of a pending request
  // was offered the form and only found out on submit, via a 403.
  it('withholds the decision form from a copied recipient and says why', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            viewer: { standing: LeaveRequestViewerStanding.Copied, canDecide: false, canOverride: false },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).not.toContain('Approve request')
    expect(markup).not.toContain('Reject request')
    expect(markup).not.toContain('Decision note')
    expect(markup).toContain('You are copied on this request')
    // A copied NON-admin holds no override, so the console must not be offered.
    expect(markup).not.toContain('override it from the admin console')
    // The card must not promise a recorded decision that does not exist yet:
    // this state is "pending, read-only", not "decided".
    expect(markup).toContain('once a primary approver records it')
    expect(markup).not.toContain('The recorded decision')
    // Read access is unchanged: the request itself still renders.
    expect(markup).toContain('Alex Employee')
  })

  // The banner is composed from identity (standing) AND capability (canOverride),
  // so an administrator who is merely copied — standing collapses to Copied, but
  // canOverride is true — is told BOTH that they are copied and that they can
  // still override. Reading standing alone would wrongly tell them they cannot
  // act at all.
  it('tells a copied administrator they can override, not just that they are copied', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            viewer: {
              standing: LeaveRequestViewerStanding.Copied,
              canDecide: false,
              canOverride: true,
            },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).not.toContain('Approve request')
    expect(markup).toContain('You are copied on this request')
    expect(markup).toContain('override it from the admin console')
  })

  it('withholds the decision form from the requester of the request', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            viewer: { standing: LeaveRequestViewerStanding.Requester, canDecide: false, canOverride: false },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).not.toContain('Approve request')
    expect(markup).toContain('This is your own request')
  })

  // Authority is opt-in: a payload without viewer context (an older API, a
  // cached response) must fall back to read-only rather than to the form.
  it('treats missing viewer context as no authority to decide', () => {
    const { viewer: _viewer, ...withoutViewer } = createRequest()
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={withoutViewer} />
      </StaticRouter>,
    )

    expect(markup).not.toContain('Approve request')
    expect(markup).toContain('not one of its primary approvers')
  })

  it('still shows the decision form to a primary approver who may decide', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    expect(markup).toContain('Approve request')
    expect(markup).toContain('Reject request')
    expect(markup).not.toContain('You are copied on this request')
  })

  // A vote is cast once, so the server withdraws canDecide after it. The page
  // must say why the buttons are gone, or the approver reads their own recorded
  // decision as a permissions failure.
  it('reports a returning approver their own vote instead of the form', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            viewer: {
              standing: LeaveRequestViewerStanding.Approver,
              canDecide: false,
              canOverride: false,
              ownVote: {
                decision: ApproverDecision.Approved,
                decidedAt: '2026-06-02T09:00:00.000Z',
              },
            },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).toContain('You approved this request')
    // A non-admin approver on an open request is sent to ask an admin.
    expect(markup).toContain('ask an administrator')
    expect(markup).not.toContain('Approve request')
    expect(markup).not.toContain('Reject request')
    // The generic "you are not an approver" line would contradict the sentence
    // above, so the own-vote notice replaces it rather than joining it.
    expect(markup).not.toContain('not one of its primary approvers')
  })

  // A voted admin-approver keeps the override, so the page points them at the
  // console — not "ask an administrator", which for a lone admin means asking
  // themselves.
  it('points a voted admin-approver at the console, not at another admin', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            viewer: {
              standing: LeaveRequestViewerStanding.Approver,
              canDecide: false,
              canOverride: true,
              ownVote: {
                decision: ApproverDecision.Approved,
                decidedAt: '2026-06-02T09:00:00.000Z',
              },
            },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).toContain('You approved this request')
    expect(markup).toContain('override it from the admin console')
    expect(markup).not.toContain('ask an administrator')
    expect(markup).not.toContain('Approve request')
  })

  // An administrator cannot force-decide a settled request either, so once the
  // request closes the override sentence would send the viewer to ask for
  // something nobody can do.
  it('drops the override advice once the request is closed', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...createRequest(),
            status: LeaveRequestStatus.Rejected,
            decidedAt: '2026-06-03T10:00:00.000Z',
            viewer: {
              standing: LeaveRequestViewerStanding.Approver,
              canDecide: false,
              canOverride: false,
              ownVote: {
                decision: ApproverDecision.Approved,
                decidedAt: '2026-06-02T09:00:00.000Z',
              },
            },
          }}
        />
      </StaticRouter>,
    )

    expect(markup).toContain('You approved this request')
    expect(markup).not.toContain('ask an administrator')
  })

  it('stays silent about a first-time approver having voted', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    expect(markup).not.toContain('You already')
  })

  // The redesigned routing list (ApproverRoutingList) attributes each recorded
  // verdict to the approver who cast it, keeps the undecided approver's
  // "awaiting decision" liveness label, and files the cc recipient in its own
  // notified-only bucket rather than counting it as an outstanding vote.
  it('attributes each recorded vote in the approval routing card', () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage requestId="request-123" initialRequest={createRequest()} />
      </StaticRouter>,
    )

    expect(markup).toContain('routing-manager@example.com')
    expect(markup).toContain('routing-director@example.com')
    expect(markup).toContain('awaiting decision')
    // The cc recipient sits under the notified-only header, never in a "to" row.
    expect(markup).toContain('CC · notified only')
    expect(markup).toContain('hr@example.com')
  })

  // A rejection closes the request while the co-approver's row stays Pending.
  // The redesigned routing list attributes the rejecting approver's verdict and
  // still lists the undecided co-approver.
  it('shows the recorded verdict for each approver on a closed request', () => {
    const base = createRequest()
    const markup = renderToStaticMarkup(
      <StaticRouter location="/employee/approval/review/request-123">
        <ApprovalReviewPage
          requestId="request-123"
          initialRequest={{
            ...base,
            status: LeaveRequestStatus.Rejected,
            decidedAt: '2026-06-03T10:00:00.000Z',
            approvers: base.approvers.map((approver) =>
              approver.email === 'manager@example.com'
                ? {
                    ...approver,
                    decision: ApproverDecision.Rejected,
                    decidedAt: '2026-06-03T10:00:00.000Z',
                  }
                : approver,
            ),
            viewer: { standing: LeaveRequestViewerStanding.Copied, canDecide: false, canOverride: false },
          }}
        />
      </StaticRouter>,
    )

    // The rejecting approver's verdict is attributed.
    expect(markup).toContain('Rejected')
    // The undecided director still appears in the routing list.
    expect(markup).toContain('routing-director@example.com')
  })
})

// The approval review page is where every approval email lands, and it fetches
// nothing but the request. Three things follow from that, and none of them held
// before the divisor started travelling with the data.
describe('approval review, rendered straight from the request', () => {
  // The module-level display divisor is shared state; a spec that moves it off
  // the default has to put it back or it leaks into whatever runs next.
  afterEach(() => {
    configureWorkdayHours(8)
  })

  const render = (request: LeaveRequestDetailDto): string =>
    renderToStaticMarkup(
      <StaticRouter location={`/employee/approval/review/${request.requestId}`}>
        <ApprovalReviewPage requestId={request.requestId} initialRequest={request} />
      </StaticRouter>,
    )

  it('reads the org workday off the request, with no dashboard or settings fetch', () => {
    // A seven-hour org. Two and a half days is 17 hours here (17.5 floored to
    // the grid), which reads 2d 3h - and 2d 4h against the eight-hour default
    // the page used to fall back to, contradicting the email that led here.
    const markup = render({
      ...createRequest(),
      hoursPerDay: 7,
      requestedDays: 2.5,
      paidDays: 2.5,
      heldDays: 2.5,
      dayPortions: { '2026-06-12': 0.5 },
    })

    expect(markup).toContain('2d 3h')
    expect(markup).not.toContain('2d 4h')
  })

  it('names WHICH date is short, in the same notation as the totals', () => {
    // The DTO froze the portions and nothing rendered them: an approver could
    // read that a three-day request cost two and a half days without ever
    // seeing which afternoon the half was.
    const markup = render({
      ...createRequest(),
      requestedDays: 2.5,
      paidDays: 2.5,
      heldDays: 2.5,
      dayPortions: { '2026-06-12': 0.5 },
    })

    expect(markup).toContain('part-day-shape')
    expect(markup).toContain('Part day')
    expect(markup).toContain(formatWeekdayDayMonth('2026-06-12'))
  })

  it('stays silent about the shape on an ordinary whole-day request', () => {
    // No empty row and no "0h": a whole-day request is what the dates already
    // say, and a row repeating it is noise on the common case.
    const markup = render(createRequest())

    expect(markup).not.toContain('part-day-shape')
    expect(markup).not.toContain('Part day')
  })

  it('shows an hours-only change as a change', () => {
    // Same week, same total, the afternoon moved from Friday to Wednesday.
    // Period, working days and funding all match, so before the shape row the
    // card told the approver nothing had changed about a proposal they still
    // had to decide.
    const base = createRequest()
    const markup = render({
      ...base,
      requestedDays: 2.5,
      paidDays: 2.5,
      heldDays: 2.5,
      dayPortions: { '2026-06-10': 0.5 },
      supersedes: {
        requestId: 'request-000',
        leaveType: base.leaveType,
        status: LeaveRequestStatus.Approved,
        startDate: base.startDate,
        endDate: base.endDate,
        requestedDays: 2.5,
        paidDays: 2.5,
        unpaidDays: 0,
        heldDays: 2.5,
        submittedAt: base.submittedAt,
        comment: base.comment,
        dayPortions: { '2026-06-12': 0.5 },
      },
    })

    expect(markup).toContain('modification-diff')
    expect(markup).toContain('Part days')
    // Both sides are spelled out: the row is only useful if it says which day
    // the hours left and which one they landed on.
    expect(markup).toContain(`${formatDayMonth('2026-06-12')} 4h`)
    expect(markup).toContain(`${formatDayMonth('2026-06-10')} 4h`)
  })
})

function createRequest(): LeaveRequestDetailDto {
  return {
    hoursPerDay: 8,
    requestId: 'request-123',
    leaveType: LeaveType.Vacation,
    status: LeaveRequestStatus.Pending,
    startDate: '2026-06-10',
    endDate: '2026-06-12',
    requestedDays: 3,
    paidDays: 3,
    unpaidDays: 0,
    heldDays: 3,
    unpaidDates: [],
    submittedAt: '2026-06-01T08:30:00.000Z',
    comment: 'Family travel',
    requesterUserId: 'employee-1',
    requesterDisplayName: 'Alex Employee',
    // The default fixture is read by an outstanding 'to' approver — the one
    // viewer the decision form belongs to.
    viewer: {
      standing: LeaveRequestViewerStanding.Approver,
      canDecide: true,
      canOverride: false,
    },
    approvers: [
      {
        email: 'manager@example.com',
        kind: ApproverKind.To,
        displayName: 'Line Manager',
        decision: ApproverDecision.Approved,
        decidedAt: '2026-06-02T09:00:00.000Z',
      },
      // Still outstanding, which is why the request above is Pending despite an
      // approval already being recorded.
      {
        email: 'director@example.com',
        kind: ApproverKind.To,
        displayName: 'Director',
        decision: ApproverDecision.Pending,
      },
      {
        email: 'hr@example.com',
        kind: ApproverKind.Cc,
      },
    ],
    activity: [
      {
        actorDisplayName: 'Alex Employee',
        action: 'submitted',
        occurredAt: '2026-06-01T08:30:00.000Z',
        // Distinct from request.comment so the "Family travel" assertion pins
        // the Decision-card requester quote, not this feed entry.
        comment: 'Two weeks with family',
      },
    ],
    balanceTimeline: [
      {
        effectiveDate: '2026-06-10',
        leaveType: LeaveType.Vacation,
        deltaDays: -3,
        availableDays: 7,
        onHoldDays: 3,
        spentDays: 2,
        reason: LeaveBalanceChangeReason.Hold,
        note: 'Held for request request-123',
      },
    ],
  }
}
