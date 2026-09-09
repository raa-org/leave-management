/*
 * Copyright (c) 2026 Right&Above, LLC
 * SPDX-License-Identifier: MIT
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import type { UserProfileType } from '@trusted-modules/auth-oidc-core'
import { CurrentUser, JwtAuthGuard } from '@trusted-modules/auth-oidc-nest'
import type {
  AdminEmployeeDetailDto,
  CreateLeavePolicyDto,
  EmployeePolicyDto,
  LeavePolicyDto,
  PolicyTransferPreflightDto,
  TransferEmployeePolicyDto,
  UpdateLeavePolicyDto,
} from '@workspace/contracts'
import {
  DuplicatePolicyTermsError,
  LeaveDomainNotFoundError,
  LeaveDomainService,
  LeaveDomainValidationError,
  PolicyInUseError,
  PolicyTransferBlockedError,
  PolicyTransferClosedPeriodError,
} from '../domain/leave-domain.service'
import { toAuditActor } from '../domain/audit-log.service'
import { isAdministrator } from '../domain/leave-viewer-context'

// The admin surface of the leave policy engine: the policy catalog and the
// per-employee membership timeline. Split from AdminLeaveController because
// the two share nothing but the guard, and the engine's error taxonomy (a
// duplicate-terms conflict, an in-use policy, a blocked transfer, a backdate
// that reaches too far) maps to statuses and payloads the leave routes have
// no use for.
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminPolicyController {
  constructor(private readonly leaveDomainService: LeaveDomainService) {}

  @Get('policies')
  getPolicies(
    @CurrentUser() user: UserProfileType,
  ): Promise<LeavePolicyDto[]> {
    this.assertAdministrator(user)
    return this.leaveDomainService.listPolicies()
  }

  @Post('policies')
  async createPolicy(
    @CurrentUser() user: UserProfileType,
    @Body() input: CreateLeavePolicyDto,
  ): Promise<LeavePolicyDto> {
    this.assertAdministrator(user)
    const terms = validatePolicyPayload(input)
    try {
      return await this.leaveDomainService.createPolicy({
        ...terms,
        createdByUserId: user.id,
        audit: toAuditActor(user),
      })
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  // Declared before policies/:policyId so Nest does not read 'default' as a
  // policy id.
  @Put('policies/default')
  async setDefaultPolicy(
    @CurrentUser() user: UserProfileType,
    @Body() input: { policyId?: string },
  ): Promise<LeavePolicyDto[]> {
    this.assertAdministrator(user)
    if (typeof input?.policyId !== 'string' || !input.policyId.trim()) {
      throw new BadRequestException('policyId is required.')
    }
    try {
      return await this.leaveDomainService.setDefaultPolicy({
        policyId: input.policyId,
        audit: toAuditActor(user),
      })
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  @Patch('policies/:policyId')
  async updatePolicy(
    @CurrentUser() user: UserProfileType,
    @Param('policyId') policyId: string,
    @Body() input: UpdateLeavePolicyDto,
  ): Promise<LeavePolicyDto> {
    this.assertAdministrator(user)
    const patch = validatePolicyPatch(input)
    try {
      return await this.leaveDomainService.updatePolicy({
        policyId,
        ...patch,
        audit: toAuditActor(user),
      })
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  @Delete('policies/:policyId')
  async deletePolicy(
    @CurrentUser() user: UserProfileType,
    @Param('policyId') policyId: string,
  ): Promise<{ deleted: true }> {
    this.assertAdministrator(user)
    try {
      await this.leaveDomainService.deletePolicy({
        policyId,
        audit: toAuditActor(user),
      })
      return { deleted: true }
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  @Get('employees/:employeeId/policy')
  async getEmployeePolicy(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
  ): Promise<EmployeePolicyDto> {
    this.assertAdministrator(user)
    try {
      return await this.leaveDomainService.getEmployeePolicy(employeeId)
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  // POST, not GET: the dry run takes a body-shaped input (policy, date, mode)
  // and its result is a computation, not an addressable resource. It writes
  // nothing.
  @Post('employees/:employeeId/policy/preflight')
  async preflightPolicyTransfer(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
    @Body() input: TransferEmployeePolicyDto,
  ): Promise<PolicyTransferPreflightDto> {
    this.assertAdministrator(user)
    const transfer = validateTransfer(input)
    if (!transfer.policyId) {
      throw new BadRequestException(
        'policyId is required to preview a transfer; create the policy first.',
      )
    }
    try {
      return await this.leaveDomainService.preflightPolicyTransfer({
        userId: employeeId,
        policyId: transfer.policyId,
        effectiveDate: transfer.effectiveDate,
        ...(transfer.mode ? { mode: transfer.mode } : {}),
      })
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  @Put('employees/:employeeId/policy')
  async transferEmployeePolicy(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
    @Body() input: TransferEmployeePolicyDto,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    const transfer = validateTransfer(input)
    // Inline creation is a SEPARATE transaction on purpose: a refused
    // transfer must still leave the new policy in the catalog (the admin
    // authored real terms, and re-creating them would hit the duplicate
    // guard). The dialog reports the refusal and the policy is there to
    // retry against.
    let policyId = transfer.policyId
    if (!policyId) {
      const created = await this.createPolicy(user, transfer.newPolicy!)
      policyId = created.policyId
    }
    try {
      await this.leaveDomainService.transferEmployeePolicy({
        userId: employeeId,
        policyId,
        effectiveDate: transfer.effectiveDate,
        ...(transfer.mode ? { mode: transfer.mode } : {}),
        ...(transfer.note ? { note: transfer.note } : {}),
        assignedByUserId: user.id,
        audit: toAuditActor(user),
      })
      return await this.leaveDomainService.getAdminEmployeeDetail(employeeId)
    } catch (error) {
      if (error instanceof PolicyTransferBlockedError) {
        // The refusal rolled its own transaction back, so the audit trail of
        // the attempt is written here, in a fresh one.
        await this.leaveDomainService.auditPolicyTransferBlocked({
          userId: employeeId,
          policyId,
          reason: error.message,
          audit: toAuditActor(user),
        })
      }
      throw this.mapPolicyError(error)
    }
  }

  @Delete('employees/:employeeId/policy/scheduled')
  async cancelScheduledTransfer(
    @CurrentUser() user: UserProfileType,
    @Param('employeeId') employeeId: string,
  ): Promise<AdminEmployeeDetailDto> {
    this.assertAdministrator(user)
    try {
      await this.leaveDomainService.cancelScheduledPolicyTransfer({
        userId: employeeId,
        audit: toAuditActor(user),
      })
      return await this.leaveDomainService.getAdminEmployeeDetail(employeeId)
    } catch (error) {
      throw this.mapPolicyError(error)
    }
  }

  private assertAdministrator(user: UserProfileType): void {
    if (!isAdministrator(user.roles)) {
      throw new ForbiddenException('Administrator access required.')
    }
  }

  // The engine's refusals carry structured detail the plain message cannot:
  // the duplicate's identity (so the dialog can offer it) and the earliest
  // permissible backdate (so it can offer a one-click re-submit).
  private mapPolicyError(error: unknown): unknown {
    if (error instanceof LeaveDomainNotFoundError) {
      return new NotFoundException(error.message)
    }
    if (error instanceof DuplicatePolicyTermsError) {
      return new ConflictException({
        message: error.message,
        code: 'duplicate_policy_terms',
        existingPolicyId: error.existingPolicyId,
        existingPolicyName: error.existingPolicyName,
      })
    }
    if (error instanceof PolicyInUseError) {
      return new ConflictException({
        message: error.message,
        code: 'policy_in_use',
      })
    }
    if (error instanceof PolicyTransferClosedPeriodError) {
      return new BadRequestException({
        message: error.message,
        code: 'backdate_out_of_range',
        earliestPermissibleDate: error.earliestPermissibleDate,
      })
    }
    if (error instanceof LeaveDomainValidationError) {
      return new BadRequestException(error.message)
    }
    return error
  }
}

function validatePolicyPayload(input: CreateLeavePolicyDto): {
  name: string
  description?: string
  vacationDays: number
  sickDays: number
  vacationAnnualIncrement?: number
  vacationIncrementEveryYears?: number
  vacationIncrementCapDays?: number
  probationMonths?: number
  paidSickDuringProbation?: boolean
  effectiveFrom: string
  effectiveTo?: string
} {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new BadRequestException('name must be a non-empty string.')
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new BadRequestException('description must be a string when supplied.')
  }
  const numeric = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException(`${label} must be a non-negative number.`)
    }
    return value
  }
  // A day term is an annual allowance, not an hourly booking, so it is held to
  // the fingerprint's two-decimal quantum rather than the books' finer one: a
  // term the fingerprint cannot tell apart (25.004 from 25.0) would be stored as
  // a distinct policy yet be refused as a duplicate, and a term past the
  // column's magnitude would surface as a Postgres 500 instead of a refusal.
  const MAX_TERM_DAYS = 9999.99
  const dayTerm = (value: unknown, label: string): number => {
    const days = numeric(value, label)
    if (days > MAX_TERM_DAYS) {
      throw new BadRequestException(
        `${label} must be at most ${MAX_TERM_DAYS} days.`,
      )
    }
    if (Math.abs(days * 100 - Math.round(days * 100)) > 1e-9) {
      throw new BadRequestException(
        `${label} must be a number of days with at most two decimals.`,
      )
    }
    return days
  }
  const optionalDayTerm = (value: unknown, label: string): number | undefined =>
    value === undefined ? undefined : dayTerm(value, label)
  if (typeof input.effectiveFrom !== 'string') {
    throw new BadRequestException('effectiveFrom must be an ISO date.')
  }
  if (input.effectiveTo !== undefined && typeof input.effectiveTo !== 'string') {
    throw new BadRequestException('effectiveTo must be an ISO date or absent.')
  }
  if (
    input.paidSickDuringProbation !== undefined &&
    typeof input.paidSickDuringProbation !== 'boolean'
  ) {
    throw new BadRequestException('paidSickDuringProbation must be a boolean.')
  }
  return {
    name: input.name.trim(),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    vacationDays: dayTerm(input.vacationDays, 'vacationDays'),
    sickDays: dayTerm(input.sickDays, 'sickDays'),
    ...(input.vacationAnnualIncrement !== undefined
      ? {
          vacationAnnualIncrement: dayTerm(
            input.vacationAnnualIncrement,
            'vacationAnnualIncrement',
          ),
        }
      : {}),
    // Years, not days: held to the plain numeric check like probationMonths,
    // never to the two-decimal day quantum. The whole-number range is enforced
    // in normalizePolicyTerms, which the import also passes through.
    ...(input.vacationIncrementEveryYears !== undefined
      ? {
          vacationIncrementEveryYears: numeric(
            input.vacationIncrementEveryYears,
            'vacationIncrementEveryYears',
          ),
        }
      : {}),
    ...(input.vacationIncrementCapDays !== undefined
      ? {
          vacationIncrementCapDays: optionalDayTerm(
            input.vacationIncrementCapDays,
            'vacationIncrementCapDays',
          )!,
        }
      : {}),
    ...(input.probationMonths !== undefined
      ? { probationMonths: numeric(input.probationMonths, 'probationMonths') }
      : {}),
    ...(input.paidSickDuringProbation !== undefined
      ? { paidSickDuringProbation: input.paidSickDuringProbation }
      : {}),
    effectiveFrom: input.effectiveFrom,
    ...(input.effectiveTo !== undefined
      ? { effectiveTo: input.effectiveTo }
      : {}),
  }
}

// Only the non-term fields are patchable; a terms field in the body is a
// mistake worth naming (terms are immutable — create a policy and transfer).
function validatePolicyPatch(input: UpdateLeavePolicyDto): {
  name?: string
  description?: string | null
  effectiveTo?: string | null
} {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  const termFields = [
    'vacationDays',
    'sickDays',
    'vacationAnnualIncrement',
    'vacationIncrementEveryYears',
    'vacationIncrementCapDays',
    'probationMonths',
    'paidSickDuringProbation',
    'effectiveFrom',
    'isDefault',
  ]
  const supplied = termFields.filter((field) => field in input)
  if (supplied.length > 0) {
    throw new BadRequestException(
      `Policy terms are immutable and cannot be edited (${supplied.join(', ')}). Create a policy with the new terms and transfer its members.`,
    )
  }
  if (input.name !== undefined && typeof input.name !== 'string') {
    throw new BadRequestException('name must be a string when supplied.')
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    typeof input.description !== 'string'
  ) {
    throw new BadRequestException(
      'description must be a string or null when supplied.',
    )
  }
  if (
    input.effectiveTo !== undefined &&
    input.effectiveTo !== null &&
    typeof input.effectiveTo !== 'string'
  ) {
    throw new BadRequestException(
      'effectiveTo must be an ISO date or null when supplied.',
    )
  }
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.effectiveTo !== undefined
      ? { effectiveTo: input.effectiveTo }
      : {}),
  }
}

function validateTransfer(input: TransferEmployeePolicyDto): {
  policyId?: string
  newPolicy?: CreateLeavePolicyDto
  effectiveDate: string
  mode?: 'retroactive' | 'prospective'
  note?: string
} {
  if (typeof input !== 'object' || input === null) {
    throw new BadRequestException('Request body must be an object.')
  }
  const hasPolicyId = typeof input.policyId === 'string' && input.policyId !== ''
  const hasNewPolicy =
    typeof input.newPolicy === 'object' && input.newPolicy !== null
  if (hasPolicyId === hasNewPolicy) {
    throw new BadRequestException(
      'Supply exactly one of policyId or newPolicy.',
    )
  }
  if (typeof input.effectiveDate !== 'string') {
    throw new BadRequestException('effectiveDate must be an ISO date.')
  }
  if (
    input.mode !== undefined &&
    input.mode !== 'retroactive' &&
    input.mode !== 'prospective'
  ) {
    throw new BadRequestException(
      "mode must be 'retroactive' or 'prospective' when supplied.",
    )
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new BadRequestException('note must be a string when supplied.')
  }
  return {
    ...(hasPolicyId ? { policyId: input.policyId! } : {}),
    ...(hasNewPolicy ? { newPolicy: input.newPolicy! } : {}),
    effectiveDate: input.effectiveDate,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.note ? { note: input.note } : {}),
  }
}
