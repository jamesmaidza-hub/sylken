import type { Tx } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'

/**
 * Supervisor approvals at the till. A cashier has no discount of their own: any discount, price change or refund
 * needs a supervisor's staff code and second PIN (checked by the API, see verifyApproverPin in auth.ts). The till
 * receives an approval id and sends it with the sale; the server then refuses a sale that was discounted,
 * re-priced or refunded without a matching, unused approval.
 */

export type ApprovalAction = 'discount' | 'price' | 'refund'

/** How long an approval stays usable, so a sale rung up offline can still be synced the next day. */
const APPROVAL_HOURS = 48

export async function issueApproval(
  tx: Tx,
  input: { approverId: string; approverCode: string; action: ApprovalAction; cashierId?: string | null; detail?: Record<string, unknown> },
): Promise<string> {
  const [a] = await tx`
    insert into till_approvals (tenant_id, approver_id, approver_code, action, cashier_id, detail)
    values (current_setting('app.tenant_id')::uuid, ${input.approverId}, ${input.approverCode}, ${input.action}, ${input.cashierId ?? null}, ${tx.json((input.detail ?? {}) as any)})
    returning id`
  await audit(tx, input.approverId, 'till_approval', 'till_approval', a.id, { action: input.action, cashierId: input.cashierId ?? null, ...(input.detail ?? {}) })
  return a.id as string
}

/** What a sale needs approving: a refund, and any line that was not charged at its list price. */
export function approvalsNeeded(sale: { kind: 'sale' | 'refund'; lines: { listTotal: number; lineTotal: number }[] }): { refund: boolean; adjusted: boolean } {
  return {
    refund: sale.kind === 'refund',
    adjusted: sale.lines.some((l) => Math.abs(l.lineTotal - l.listTotal) > 0.004),
  }
}

/**
 * Check a recorded sale's approvals and use them up. Throws (so the sale is rolled back and kept under till problems)
 * when a refund or a price change has no matching approval. A discount or price change is covered by either kind.
 */
export async function consumeApprovals(tx: Tx, saleId: string, sale: { kind: 'sale' | 'refund'; lines: { listTotal: number; lineTotal: number }[] }, ids: string[] = []) {
  const need = approvalsNeeded(sale)
  if (!need.refund && !need.adjusted) return
  const rows = ids.length
    ? await tx`
        select id, action from till_approvals
         where id = any(${ids}::uuid[]) and used_sale_id is null and issued_at > now() - ${APPROVAL_HOURS + ' hours'}::interval
         for update`
    : []
  const has = (a: ApprovalAction[]) => rows.filter((r) => a.includes(r.action as ApprovalAction))
  if (need.refund && !has(['refund']).length) throw new DomainError('this refund has no supervisor approval')
  if (need.adjusted && !has(['discount', 'price']).length) throw new DomainError('this sale has a discount or price change with no supervisor approval')
  await tx`update till_approvals set used_sale_id = ${saleId} where id = any(${rows.map((r) => r.id)}::uuid[])`
}
