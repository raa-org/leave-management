# Leave Management System
## Technical White Paper

**Accurate leave is a policy problem, not a form problem**

**Organization:** Right&Above  
**Version:** 1.0  
**Publication date:** September 2026  
**Document status:** Public technical white paper  
**Source:** MIT-licensed reference implementation and runnable demo

A reasoned approach to self-hosted leave management for organisations that already run their own identity directory.

Leave Management System is a self-hosted web application that keeps vacation and sick-leave balances accurate, applies company leave policy automatically, and routes requests to the right approvers by email. This paper argues that the failure mode in leave administration is not missing forms — it is the absence of an executable policy and a single attributable ledger.

---

## Contents

1. Abstract
2. The problem in industry context
3. What would have to be true for leave to be trustworthy
4. Approach
5. Who does what
6. Architecture, as a consequence of the approach
7. Evidence from the implementation
8. Scope, applicability, and limits
9. Conclusion
10. Notes and sources

## Executive Summary

Leave administration is often treated as a request-and-approval workflow. In practice, the difficult part is maintaining a correct, explainable balance under changing policy, calendars, employment history, and approval state.

This paper presents a narrower alternative to a general HRIS: a self-hosted leave-management system for organisations that already operate a corporate identity directory. Its central design principle is that **leave policy is executable**. Accrual, reservation, consumption, carryover, probation, calendars, and policy membership are represented as data and applied by a deterministic domain engine.

The system separates **held** time from **spent** time, takes application roles from the identity provider, treats per-person exceptions as explicit policies, and preserves policy membership as a dated history. The result is a leave ledger that can answer not only “what is the balance?” but also “why is the balance this number?”, “who approved the request?”, and “which policy version applied?”.

The paper is intentionally not a claim of customer ROI or production performance. Its evidence is the implementation model, automated domain tests, architecture, and reproducible public artefacts.

## Abstract

Most mid-sized organisations still administer leave in spreadsheets and mail threads. That arrangement looks cheap until two people quote two remaining balances, a public holiday is counted on one sheet and ignored on another, or HR cannot reconstruct why a number moved. The volume of absence is not falling: CIPD’s 2025 *Health and wellbeing at work* survey records 9.4 days of absence per employee, or 4.1% of working time.[1] Spreadsheets are a poor ledger for that volume. Controlled studies of spreadsheet development find cell-level error rates of about 1–5%; reviews of operational workbooks find errors in a large majority of them.[2]

Commercial HR suites can replace the spreadsheet, but they solve a different job. They sit outside the company’s identity directory, cost per seat, and rarely encode the local rules that actually determine a balance: monthly accrual, probation, seniority steps, country calendars, and booking by the hour. The result is a second, shadow record of “who is allowed to do what,” kept next to the directory that already knows.

This paper analyses that gap and describes a narrower design. Policy is the unit of computation. A submitted request moves working time into **hold**; rejection releases it; approval consumes it as it is taken. Roles come from the identity token. Every per-person exception is itself a policy — there is no hidden override on a single account. The system is not a full HRIS. It does one job: leave.

---

## 1. The problem in industry context

### 1.1 Leave is a running ledger

A leave balance is not a calendar annotation. It is a running account with four moving parts:

1. **Accrual** — how entitlement is earned over time (monthly, yearly, prorated from hire).
2. **Reservation** — time that has been requested but not yet decided, which must not be spent twice.
3. **Consumption** — time that has been approved and taken, net of weekends and public holidays.
4. **Carryover** — what survives a year boundary, and under what cap.

If any of those four is computed in a different place, or by a different person, the organisation no longer has one number. It has several plausible numbers. That is the operational failure. The institutional failure is worse: when a dispute arrives, there is no reconstructable reason the number is what it is.

This is why “we have a form” does not solve leave. A form captures intent. It does not apply policy.

### 1.2 The volume is large enough that informal methods do not scale

Absence is not a rare exception that a spreadsheet can babysit. CIPD’s 2025 survey, supported by Simplyhealth, puts average employee absence at **9.4 days** — a record in that series, up from 7.8 days in 2023 — equivalent to **4.1% of working time**.[1] That figure is about sickness absence in the UK, not vacation worldwide, but the implication travels: leave and absence are material labour costs, and they are processed as high-frequency, low-glamour transactions. A 200-person firm generating a few requests a day will accumulate thousands of ledger events a year. Informal methods fail at that frequency long before they fail at “does anyone remember the rule.”

AbsenceSoft’s *State of Leave and Accommodations* research, summarised in their leave-management briefing, reports that **41% of HR teams still manage leave with spreadsheets and email**.[3] SHRM’s coverage of leave-management vendors makes the same observation from the other side: organisations otherwise fall back on ad hoc reporting to answer questions that a ledger should answer in one place.[4]

### 1.3 Spreadsheets are a known-bad computational substrate

The argument against spreadsheets is not aesthetic. It is empirical.

Ray Panko’s review of spreadsheet error research (widely circulated as “Spreadsheet Errors: What We Know. What We Think We Can Do”) reports cell error rates in the **1–5%** range on development tasks of modest complexity — comparable to human error rates on other non-trivial cognitive work. Because a leave workbook is a chain of formula cells (hire date → employed months → accrual → holds → remaining), a 1% cell error rate is enough to corrupt the bottom line of almost every non-trivial sheet. Studies of operational spreadsheets find errors in a large majority of workbooks; the commonly cited synthesis is **about 88%**.[2]

Leave workbooks add failure modes that laboratory tasks understate:

- **Two writers.** HR and a line manager each keep a copy; they diverge on the first rejected request.
- **Hidden calendar.** Weekends are skipped by habit; public holidays live on a third sheet, or in someone’s head.
- **Rounding as policy.** A half-day becomes a full day because the cell is formatted as an integer.
- **No audit.** When a number moves, the sheet cannot say who moved it or which rule applied.

The cost is not only a wrong remaining balance. It is the meeting that reconstructs the year from mail.

### 1.4 Commercial HR suites solve a broader job, and miss this one

The obvious alternative to the spreadsheet is a commercial HR platform. For organisations that want a full HRIS — payroll, performance, recruiting, benefits — that is the right purchase. For organisations that already run identity (Keycloak, LDAP, a corporate directory) and need leave to be correct, it is often the wrong one, for three structural reasons.

**Identity is duplicated.** The suite has its own user table. Roles, joiners and leavers are copied from the directory and then drift. Sign-in may be federated; authorisation usually is not. The leave system becomes a second source of “who may approve whose request.”

**Local rules are configuration theatre.** Monthly accrual, a probation window that forces vacation unpaid while leaving sick paid, seniority steps that land on 1 January rather than the hire anniversary, hourly bookings, a country holiday calendar that is not the employee’s residence country — these are ordinary in engineering and professional-services firms, and awkward in products designed around a single PTO bucket for a US-centric workforce.

**The unit of cost is the seat, not the job.** A firm that needs an accurate leave ledger pays for a platform whose centre of gravity is elsewhere. The leave module is rarely the reason the suite is good.

None of this is an argument that HR suites are poorly built. It is an argument that **leave, done correctly, is a policy engine with an approval workflow**, not a screen in a general HRIS.

### 1.5 Why not a conventional HRIS?

The alternatives are not equivalent because they optimise for different jobs. A spreadsheet is flexible but weak as an auditable computational system. A general HRIS can provide leave functionality, but organisations with an existing identity directory may still need to duplicate identity, approval relationships, and local policy inside the HR platform.

The proposed system deliberately narrows the problem:

| Requirement | Spreadsheet | General HRIS | Leave Management System |
| --- | --- | --- | --- |
| Self-hosted deployment | Possible | Product-dependent | Yes |
| Existing identity provider as role source | No | Often partial | Yes |
| Executable leave policy | Fragile formulas | Product-dependent | Yes |
| Hold before approval | Manual | Product-dependent | Yes |
| Policy-version audit trail | Weak | Product-dependent | Yes |
| Hour-based bookings | Possible | Product-dependent | Yes |
| Excel migration path | Yes | Product-dependent | Yes |

This is positioning, not a claim that every HRIS lacks these capabilities. The relevant distinction is that the leave system makes them the centre of the design rather than features surrounding a broader HR platform.

## 2. What would have to be true for leave to be trustworthy

A leave system is trustworthy when a competent outsider can answer four questions from the system of record, without asking a person:

| Question | What “good” looks like |
| --- | --- |
| What is this person’s remaining balance? | One number, derived, not typed. |
| Why is it that number? | A timeline of accruals, holds, consumptions, carryover and policy membership. |
| Who decided the last request? | A named approver, authenticated against the directory, checked against the addressee list. |
| What rule applied? | A policy version, not a cell comment and not a one-off override on the account. |

Those questions imply design constraints. They are worth stating before the product, because they are the reasons the product is shaped the way it is.

1. **Policy must be executable.** A policy that exists only as a PDF in a handbook will be re-implemented, wrongly, in the next spreadsheet. The terms — allowances, increments, probation, carryover, paid-sick flag — have to be data that a deterministic function can apply.
2. **Reservation must be first-class.** If a pending request does not hold time, two overlapping requests can both be “within remaining.” If it holds time in the same bucket as spent time, rejection cannot restore the balance cleanly.
3. **The calendar is an input, not a footnote.** Weekends and public holidays are part of the function that turns a date range into working time. They cannot be a courtesy the approver remembers.
4. **Exceptions are policies.** A “special deal” for one person that lives as a hidden flag will be invisible to the next administrator and unauditable in a dispute. The honest model is a policy with one member.
5. **Identity is not a local table.** Who may submit, who may approve, and who may see everyone else are directory facts. The application should refuse a session that does not carry an application role.
6. **A policy change is a dated event.** “We changed the handbook in March” is not an algorithm. The system has to say whether the new terms apply from a date forward, or recompute the current leave year retroactively, and then do only that.

If a design violates any of these, it will recreate the spreadsheet’s failure modes with a nicer UI.

## 3. Approach

Leave Management System is an internal web application for organisations that already run SSO (OpenID Connect / Keycloak) and, optionally, LDAP. It is not a full HRIS. Employees see only their own data; administrators see everyone. Approvers receive an email with a link, sign in with company SSO, and approve or reject; access is checked against the addressee list, not a shared inbox.

The rest of this section is the reasoning, not the feature list.

### 3.1 Policy is the unit of computation

Each employee belongs to exactly one leave policy at a time. A policy is a complete, named set of terms:

- vacation and sick allowances;
- optional annual step-up (extra vacation days every *N* years of employment, optionally capped);
- a probation window, and whether sick leave stays paid inside it;
- carryover rules;
- the implication, used everywhere, that there is no second place to put a one-off exception.

Seniority steps anchor to the **hire year** and land on 1 January. That is a deliberate coarseness. The hire year is already prorated by the half-month rule (below), so the short first year does not need a special case; a mid-year transfer does not reset progression. The alternative — anniversary-based steps — looks more precise and produces a class of bugs around “which anniversary, under which policy, after a transfer.”

A policy change can be applied from a date forward, or recomputed retroactively within the current leave year. In both cases the membership timeline is the input: live rows, half-open intervals, the earliest row extending backward to cover hire-before-enrolment. Superseded rows remain as audit history. There is no “edit the allowance on the person.”

### 3.2 Accrual is a pure function of membership and time

Vacation accrues **monthly**. Sick leave is credited as a **yearly tranche**, prorated from the hire month. A month of employment counts only if the person worked at least half of it (the half-month rule; February and 31-day months have explicit thresholds). Days are rounded to a fixed precision so the ledger does not oscillate.

This split is not cosmetic. Vacation is earned with time served; sick leave is an annual grant that a mid-year hire should not receive in full. Treating both as the same monthly drip, or both as a lump on 1 January, is how organisations end up arguing about January joiners.

The engine that turns a membership timeline into a per-month rate schedule is deliberately entity-free: the same function is unit-tested without a database. That is the difference between “we have business rules” and “we have an implementation of business rules that can be shown to be stable.”

### 3.3 Hold, then consume — never the reverse

A submitted request does not spend time. It moves working time into **hold**, skipping weekends and the holiday calendar that applies to that employee. Rejection releases the hold. Approval consumes the days (or hours) as they are taken.

The order matters. Spend-on-submit makes rejection a correction. Hold-on-submit makes rejection a no-op on the spent column and a release on the reserved column. Two pending requests cannot both claim the same remaining day, because remaining is `accrued − held − spent` (plus carryover, minus caps), and both holds are visible.

Hourly bookings use the same state machine. A half-day is not “0.5 typed into a cell”; it is a duration the calendar function accepts.

### 3.4 Identity comes from the token

Users are provisioned from the identity provider. Roles (`Employee`, `Administrator`) are read from the ID token — directory groups, not a checkbox in the app. Signing in without an application role is refused. There is no anonymous path into the API.

Approver access is a second check: the authenticated user must be on the request’s addressee list. A shared “approvers@” mailbox cannot approve by being in the To line. That closes the common failure where anyone who received the mail can act.

LDAP, when enabled, syncs people and roles into the employee directory. Login still goes through OIDC. The directory is a cache of identity, not a second identity.

### 3.5 Import and export are the same shape

Existing tracker history can be imported from Excel and exported in the same shape. That is a migration constraint, not a feature for its own sake: organisations will not cut over if the old ledger cannot be replayed. Import joins employees to policies by terms, not by inventing a silent override when the file disagrees with the catalog.

## 4. Who does what

The product surface follows the constraints in section 2. It is included here so the approach can be evaluated against the actual jobs, not against an abstract architecture.

| Who | What they do |
| --- | --- |
| Employees | See accrued, held, spent and remaining vacation and sick leave; submit a request (type, dates, optional hours, comment, approvers); follow their own history and balance timeline. |
| Approvers | Receive an email with a link, sign in with company SSO, and approve or reject. Access is checked against the addressee list, not a shared inbox. |
| Administrators | Manage the employee directory, leave policies, holiday calendars, default approvers, activity, and a full audit trail. Existing tracker history can be imported from Excel and exported in the same shape. |

## 5. Architecture, as a consequence of the approach

The stack is a TypeScript Nx monorepo. Secrets stay in environment variables; this paper does not describe any specific deployment.

| Layer | Choice | Why it is in this paper |
| --- | --- | --- |
| Frontend | React 18, Material UI, Vite | One employee workspace, one administrator workspace. No public site. |
| API | NestJS 11, REST, OpenAPI | Policy and request mutations go through the API; the browser is not a second engine. |
| Data | PostgreSQL, TypeORM, versioned migrations | The ledger and the membership timeline are relational on purpose. `synchronize` is off. |
| Identity | OIDC (Keycloak); roles from the token / directory groups | Constraint 5: no local role table. |
| Notifications | Transactional email (To + CC) with an approval link | Approvers are addressed, not broadcast. |
| Directory | Optional LDAPS sync of people and roles | Joiner/leaver hygiene without a second login. |

Two properties are load-bearing.

**The browser does not compute remaining balance.** It displays what the API derived from policy membership, the calendar, and the request ledger. A crafted client cannot grant itself days.

**The policy engine is testable without the web stack.** Accrual, the half-month rule, probation, carryover caps and retroactive transfer are covered by domain tests. That is the evidence that “policy is executable” is not a slogan.

## 6. Evidence from the implementation

A design paper that never touches the artefact it describes is a prospectus. Two kinds of evidence are available here: that the domain rules exist as tested code, and that the surrounding product was not assembled by hand from a blank repository.

### 6.1 Domain rules as tests

The policy engine’s core — year schedule, monthly targets, carryover caps, probation gates, retroactive transfer — is expressed as pure functions and exercised by specification tests. Examples of claims those tests pin down:

- A month counts toward accrual only under the half-month rule; February and 31-day months have explicit thresholds.
- Vacation increments with seniority on the hire year, not the anniversary, and never produces a negative allowance for a future hire date.
- A policy transfer mid-year recomputes accrued days from the membership timeline; the difference is posted, not typed.
- Probation can force vacation unpaid while leaving sick paid, per policy, and a transfer does not silently rewrite already-approved days inside a new probation window.

That is the standard of evidence this paper can honestly offer for the approach in section 3: the rules are written down, and a failing change is a failing test. It is not a field study of error rates after go-live. Organisations evaluating the system should treat the public demo and the test suite as the primary artefacts, and this paper as the argument for why those artefacts are shaped that way.

### 6.1.1 Representative verification cases

The following cases illustrate the kinds of invariants that should be verified by the domain test suite. They are examples of verification structure, not independently reported customer measurements.

| Case | Input condition | Expected invariant |
| --- | --- | --- |
| Half-month accrual | Hire occurs before/after the defined monthly threshold | Only qualifying months contribute |
| Pending request | Request is submitted but not approved | Working time moves to hold, not spent |
| Rejection | Held request is rejected | Hold is released; spent balance is unchanged |
| Mid-year policy transfer | Employee changes policy during the year | Accrual is recomputed from membership history and the difference is posted |
| Probation | Vacation is requested during probation | Policy determines paid/unpaid treatment; sick-leave treatment remains independent |
| Future hire | Hire date is later than the calculation date | Accrual does not become negative |

A production evaluation should additionally run these cases against the published test suite and inspect the corresponding implementation and migration history.

### 6.2 How the product was assembled

The system was bootstrapped with Right&Above’s Application Assembly Pipeline (AAP), an in-house code-generation platform for TypeScript monorepos. AAP emitted the first runnable product; engineers and agents extended it with leave-specific rules. Line-count share of each layer inherited from the scaffold:

| Dimension | Share inherited from AAP |
| --- | --- |
| Frontend architecture | 79% |
| Screens and routes | 78% |
| Design system | 74% |
| Backend modules | 73% |
| HTTP API | 69% |
| Data model | 67% |
| Shared contracts | 65% |
| Average structural inheritance | 72% |

The scaffold was **10,663 lines**. The repository later grew to **133,891 lines** as domain logic was added on top. Every one of the seven layers inherits a majority from AAP.

These figures measure **structural inheritance**, not the share of product value that is generated. The policy engine in section 3 is precisely the part that is *not* a scaffold. The honest reading is: the cost of a trustworthy leave ledger is the domain, not the monorepo ritual around it. AAP is evidence that the surrounding product can be produced without a year of undifferentiated engineering; it is not evidence that leave policy can be generated.

## 7. Scope, applicability, and limits

**Who should use it.** Engineering and professional-services firms that want leave in-house, already operate Keycloak (and often LDAP), and need balances that survive real policy — hourly bookings, country calendars, seniority increments, carryover, and an auditable approval trail — without buying a general-purpose HR platform.

**Who should not.** Organisations that need payroll, benefits administration, recruiting, or performance in the same product. Organisations with no identity provider and no intention of running one. Organisations whose leave rules cannot be stated as a policy (if the real rule is “the director decides,” a ledger will not help).

**What this paper does not claim.** It does not claim a measured reduction in payroll errors at a named customer. It does not claim that 72% of the *value* of the product was generated. It does not describe a specific production deployment, host, or secret. The live demo and the MIT-licensed source are the public artefacts; this paper is the argument.

## 8. Conclusion

Leave goes wrong when intent, policy and ledger live in different places. Spreadsheets keep a ledger that cannot explain itself. Mail threads keep intent that nobody applies. HR suites keep a platform whose centre of gravity is not the local rule.

The approach argued here is narrower. Make policy executable. Hold time before spending it. Take identity from the directory. Treat exceptions as policies. Keep the calendar inside the function that counts working time. The product that follows from those constraints is a self-hosted leave system, not a brief for a larger HR suite.

A white paper should be judged by whether a reader can disagree with the argument. The disagreement worth having is this: either leave is a form, in which case a spreadsheet is enough, or leave is a computation, in which case the computation has to live in one place, with a name on every change.

---

## Notes

## References and Public Artefacts

MIT-licensed source and a runnable demo stack: https://github.com/raa-org/leave-management

Live demo: https://apexianlab-leave.rightandabove.com/

1. CIPD, in partnership with Simplyhealth, *Health and wellbeing at work 2025*. Average absence of 9.4 days per employee (4.1% of working time), up from 7.8 days in the 2023 survey. https://www.cipd.org/
2. Raymond R. Panko, “Spreadsheet Errors: What We Know. What We Think We Can Do,” *Proceedings of the Spreadsheet Risk Symposium* / EuSpRIG; preprint at https://arxiv.org/abs/0802.3457. Development experiments typically show cell error rates of 1–5%. The ~88% figure for operational spreadsheets containing at least one error is the conventional synthesis of field studies discussed in that literature (see also Panko’s compiled research pages at https://panko.com/ssr/).
3. AbsenceSoft, “Leave Management Software 101,” summarising their *State of Leave and Accommodations* research: 41% of HR teams still manage leave with spreadsheets and email. https://absencesoft.com/resources/leave-management-software-101-everything-hr-needs-to-know/
4. Society for Human Resource Management, “Choosing the Right Leave Management Vendor Pays Off,” SHRM, noting that organisations otherwise fall back on ad hoc reporting methods and spreadsheets for leave administration. https://www.shrm.org/topics-tools/news/technology/choosing-right-leave-management-vendor-pays
