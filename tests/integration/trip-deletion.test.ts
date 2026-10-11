// OPS-03: deleting a trip removes data and photos for good, and nothing else.
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { addExpense, balances, closeDb, createUser, db, equal, rpc, rpcFails, setupTrip } from './helpers'

afterAll(closeDb)

describe('Reiselöschung', () => {
  it('löscht Daten und Fotos vollständig, andere Reisen und Konten bleiben unberührt', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const larissa = await createUser('Larissa', { google: true })
    const { tripId, personIds } = await setupTrip(erwin, [larissa])
    const other = await setupTrip(erwin, [larissa])
    await addExpense(larissa, other.tripId, { currency: 'EUR', minor: 1000, participants: equal(other.personIds.Erwin, other.personIds.Larissa) })
    const otherBefore = await balances(larissa, other.tripId)

    const expenseId = await addExpense(larissa, tripId, { currency: 'EUR', minor: 5000, participants: equal(personIds.Erwin, personIds.Larissa) })
    const jpeg = readFileSync('tests/fixtures/receipt-1.jpg')
    const path = `${tripId}/${expenseId}/${randomUUID()}.jpg`
    expect((await larissa.client.storage.from('receipts').upload(path, jpeg, { contentType: 'image/jpeg' })).error).toBeNull()
    await rpc(larissa.client, 'attach_receipt', { p_expense_id: expenseId, p_storage_path: path, p_sha256: createHash('sha256').update(jpeg).digest('hex') })
    const { data: tripRow } = await erwin.client.from('trips').select('title').eq('id', tripId).single()
    const title = tripRow!.title as string

    await rpcFails(erwin.client, 'request_trip_deletion', { p_trip_id: tripId, p_confirm_title: title }, 'trip_not_archived')
    await rpc(erwin.client, 'archive_trip', { p_trip_id: tripId, p_accept_open_balances: true })
    await rpcFails(larissa.client, 'request_trip_deletion', { p_trip_id: tripId, p_confirm_title: title }, 'admin_required')
    await rpcFails(erwin.client, 'request_trip_deletion', { p_trip_id: tripId, p_confirm_title: `${title} ` }, 'confirm_title_mismatch')
    await rpcFails(erwin.client, 'delete_trip', { p_trip_id: tripId }, 'deletion_not_requested')

    const paths = await rpc<string[]>(erwin.client, 'request_trip_deletion', { p_trip_id: tripId, p_confirm_title: title })
    expect(paths).toEqual([path])
    await rpcFails(erwin.client, 'delete_trip', { p_trip_id: tripId }, 'receipts_remaining')

    // Only the admin may purge; a member's attempt removes nothing.
    await larissa.client.storage.from('receipts').remove(paths)
    expect((await db().query(`select count(*)::int as n from storage.objects where name like $1`, [`${tripId}/%`])).rows[0].n).toBe(1)
    const removed = await erwin.client.storage.from('receipts').remove(paths)
    expect(removed.error).toBeNull()
    expect(removed.data).toHaveLength(1)

    await rpc(erwin.client, 'delete_trip', { p_trip_id: tripId })

    const left = await db().query(
      `select (select count(*) from public.trips where id = $1) + (select count(*) from public.expenses where trip_id = $1)
            + (select count(*) from public.audit_events where trip_id = $1) + (select count(*) from public.trip_closures where trip_id = $1)
            + (select count(*) from public.receipt_files where trip_id = $1) + (select count(*) from public.trip_people where trip_id = $1)
            + (select count(*) from storage.objects where name like $1::text || '/%') as n`,
      [tripId],
    )
    expect(Number(left.rows[0].n)).toBe(0)
    const tomb = await db().query('select * from private.deleted_trips where trip_id = $1', [tripId])
    expect(tomb.rows[0]).toMatchObject({ expense_count: 1, file_count: 1 })
    expect(JSON.stringify(tomb.rows[0])).not.toContain(title)

    const { data: notices } = await larissa.client.from('in_app_notices').select('kind, payload').eq('kind', 'trip_deleted')
    expect(notices).toEqual([{ kind: 'trip_deleted', payload: { trip_title: title } }])
    expect(await balances(larissa, other.tripId)).toEqual(otherBefore)
    const { data: mine } = await larissa.client.from('trips').select('id')
    expect(mine!.map((t) => t.id)).toEqual([other.tripId])
  })

  it('Wiederöffnen bricht eine begonnene Löschung ab', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const { tripId } = await setupTrip(erwin, [])
    const { data } = await erwin.client.from('trips').select('title').eq('id', tripId).single()
    await rpc(erwin.client, 'archive_trip', { p_trip_id: tripId, p_accept_open_balances: true })
    await rpc(erwin.client, 'request_trip_deletion', { p_trip_id: tripId, p_confirm_title: data!.title })
    await rpc(erwin.client, 'reopen_trip', { p_trip_id: tripId })
    await rpc(erwin.client, 'archive_trip', { p_trip_id: tripId, p_accept_open_balances: true })
    await rpcFails(erwin.client, 'delete_trip', { p_trip_id: tripId }, 'deletion_not_requested')
  })
})
