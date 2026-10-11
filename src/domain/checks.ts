import type { Tx } from '../db/index.js'
import { DomainError } from './errors.js'
import { audit } from './items.js'

/**
 * Independent checking of a dispensed script. The person who dispensed it can never check it;
 * the database refuses that too (trigger script_check_guard in migrations/008_access.sql), so
 * the rule holds even if this code is bypassed.
 */

export interface ScriptCheck { checkedBy: string; checkedByName: string; checkedAt: Date }

export async function checkScript(tx: Tx, scriptId: string, userId: string) {
  const [s] = await tx`select status, dispensed_by, script_no from scripts where id = ${scriptId}`
  if (!s) throw new DomainError('unknown script', 'not_found', 404)
  if (s.status !== 'dispensed') throw new DomainError('only a dispensed script can be checked')
  if (s.dispensed_by === userId) throw new DomainError('you dispensed this script, so someone else must check it', 'own_check', 403)
  const [done] = await tx`select 1 from script_checks where script_id = ${scriptId}`
  if (done) throw new DomainError(`script ${s.script_no} has already been checked`, 'already_checked', 409)
  await tx`insert into script_checks (tenant_id, script_id, checked_by) values (current_setting('app.tenant_id')::uuid, ${scriptId}, ${userId})`
  await audit(tx, userId, 'check', 'script', scriptId, { scriptNo: s.script_no })
}

export async function scriptCheck(tx: Tx, scriptId: string): Promise<ScriptCheck | null> {
  const [c] = await tx`select c.checked_by, c.checked_at, u.name from script_checks c join users u on u.id = c.checked_by where c.script_id = ${scriptId}`
  return c ? { checkedBy: c.checked_by, checkedByName: c.name, checkedAt: c.checked_at } : null
}

/**
 * Labels print only for a script someone other than the dispenser has checked (james,
 * 2026-10-11). For the label of an owed item handed over later, the original script must be checked.
 */
export async function requireChecked(tx: Tx, ref: { scriptId?: string; supplyId?: string }) {
  const [row] = ref.scriptId
    ? await tx`select s.script_no, c.id as check_id from scripts s left join script_checks c on c.script_id = s.id where s.id = ${ref.scriptId}`
    : await tx`select s.script_no, c.id as check_id from owed_supplies os join owed_items o on o.id = os.owed_item_id
                 join script_lines l on l.id = o.script_line_id join scripts s on s.id = l.script_id
                 left join script_checks c on c.script_id = s.id where os.id = ${ref.supplyId ?? null}`
  if (!row) throw new DomainError('unknown script', 'not_found', 404)
  if (!row.check_id) {
    throw new DomainError(`Script ${row.script_no ?? ''} has not been checked yet. A pharmacist other than the person who dispensed it checks it, then the labels print.`, 'not_checked', 409)
  }
}
