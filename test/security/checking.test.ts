import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../../src/db/index.js'
import { checkScript } from '../../src/domain/checks.js'
import { dispenseScript } from '../../src/domain/scripts.js'
import { appDb } from '../helpers.js'
import { draftScript, pharmacy } from './fixtures.js'

// Requirement 1.8: the person who checks a script is not the person who dispensed it.

let db: Sql
let p: Awaited<ReturnType<typeof pharmacy>>
beforeAll(async () => { db = appDb(); p = await pharmacy(db) })
afterAll(async () => { await db.end() })

const checks = (scriptId: string) => p.t.as((tx) => tx`select checked_by from script_checks where script_id = ${scriptId}`)

async function dispensedBy(who: typeof p.pharmacist) {
  const { scriptId } = await draftScript(p.t)
  await who.post(`/dispensary/scripts/${scriptId}/dispense`)
  return scriptId
}

describe('1.8 dispenser and checker are different people', () => {
  it('refuses a pharmacist checking a script they dispensed themselves', async () => {
    const id = await dispensedBy(p.pharmacist)
    const res = await p.pharmacist.post(`/dispensary/scripts/${id}/check`)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('someone else must check it')
    expect(await checks(id)).toEqual([])
    expect(await (await p.pharmacist.get(`/dispensary/scripts/${id}`)).text()).not.toContain('I have checked this script')
  })

  it('lets a second pharmacist check it, once', async () => {
    const id = await dispensedBy(p.pharmacist)
    await p.pharmacist2.post(`/dispensary/scripts/${id}/check`)
    expect((await checks(id)).map((r) => r.checked_by)).toEqual([p.pharmacist2.id])
    expect(await (await p.pharmacist.get(`/dispensary/scripts/${id}`)).text()).toContain('Checked by <b>Second pharmacist</b>')
    await p.pharmacist.post(`/dispensary/scripts/${id}/check`)
    expect((await checks(id)).length).toBe(1)
  })

  it('lets a pharmacist check a dispenser\'s work, but not the other way round', async () => {
    const id = await dispensedBy(p.dispenser)
    expect((await p.dispenser.post(`/dispensary/scripts/${id}/check`)).status).toBe(403)
    expect((await p.assistant.post(`/dispensary/scripts/${id}/check`)).status).toBe(403)
    await p.pharmacist.post(`/dispensary/scripts/${id}/check`)
    expect((await checks(id)).map((r) => r.checked_by)).toEqual([p.pharmacist.id])
  })

  it('is enforced by the database itself, so code that skips the check still cannot do it', async () => {
    const { scriptId } = await draftScript(p.t)
    await p.t.as((tx) => dispenseScript(tx, scriptId, {}, p.pharmacist.id))
    await expect(p.t.as((tx) => tx`insert into script_checks (tenant_id, script_id, checked_by) values (${p.t.id}, ${scriptId}, ${p.pharmacist.id})`))
      .rejects.toThrow(/cannot check it/)
    await p.t.as((tx) => checkScript(tx, scriptId, p.pharmacist2.id))
    await expect(p.t.as((tx) => tx`update script_checks set checked_by = ${p.pharmacist.id} where script_id = ${scriptId}`)).rejects.toThrow(/never changed/)
    await expect(p.t.as((tx) => tx`delete from script_checks where script_id = ${scriptId}`)).rejects.toThrow(/never changed/)
  })

  it('cannot check a draft', async () => {
    const { scriptId } = await draftScript(p.t)
    await expect(p.t.as((tx) => checkScript(tx, scriptId, p.pharmacist2.id))).rejects.toThrow(/only a dispensed script/)
  })
})
