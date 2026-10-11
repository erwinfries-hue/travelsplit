// SEC-09 (private receipts) and SEC-02 for realtime subscriptions.
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addExpense, closeDb, createUser, equal, rpc, rpcFails, setupTrip, type TestUser, type TripSetup } from './helpers'

// Smallest valid JPEG (1×1 px).
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)

let ef: TestUser
let lg: TestUser
let mallory: TestUser
let trip: TripSetup
let expenseId: string
let path: string

beforeAll(async () => {
  ef = await createUser('Erwin', { creator: true })
  lg = await createUser('Larissa', { google: true })
  mallory = await createUser('Mallory', { google: true })
  trip = await setupTrip(ef, [lg])
  expenseId = await addExpense(ef, trip.tripId, { currency: 'EUR', minor: 2500, participants: equal(trip.personIds.Larissa) })
  path = `${trip.tripId}/${expenseId}/${randomUUID()}.jpg`
})
afterAll(closeDb)

describe('SEC-09: Belegfotos privat', () => {
  it('Ersteller lädt hoch und verknüpft; Mitglied liest per kurzlebiger URL', async () => {
    const up = await ef.client.storage.from('receipts').upload(path, TINY_JPEG, { contentType: 'image/jpeg' })
    expect(up.error).toBeNull()
    const sha = createHash('sha256').update(TINY_JPEG).digest('hex')
    expect(await rpc(ef.client, 'attach_receipt', { p_expense_id: expenseId, p_storage_path: path, p_sha256: sha })).toBeNull()

    const signed = await lg.client.storage.from('receipts').createSignedUrl(path, 60)
    expect(signed.error).toBeNull()
    const res = await fetch(signed.data!.signedUrl)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(TINY_JPEG)).toBe(true)
  })

  it('Fremder Nutzer: kein Download, keine signierte URL, kein Listing', async () => {
    const dl = await mallory.client.storage.from('receipts').download(path)
    expect(dl.data).toBeNull()
    const signed = await mallory.client.storage.from('receipts').createSignedUrl(path, 60)
    expect(signed.data).toBeNull()
    const list = await mallory.client.storage.from('receipts').list(trip.tripId)
    expect(list.data ?? []).toEqual([])
    // Direct object URL without a token.
    const res = await fetch(`${(ef.client as unknown as { storageUrl: string }).storageUrl}/object/receipts/${path}`)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('Fremder Nutzer und Nicht-Ersteller können nicht in fremde Ausgaben hochladen oder Belege löschen', async () => {
    const evil = `${trip.tripId}/${expenseId}/${randomUUID()}.jpg`
    expect((await mallory.client.storage.from('receipts').upload(evil, TINY_JPEG, { contentType: 'image/jpeg' })).error).not.toBeNull()
    expect((await lg.client.storage.from('receipts').upload(evil, TINY_JPEG, { contentType: 'image/jpeg' })).error).not.toBeNull()
    await mallory.client.storage.from('receipts').remove([path])
    await lg.client.storage.from('receipts').remove([path])
    expect((await ef.client.storage.from('receipts').download(path)).data).not.toBeNull()
    await rpcFails(mallory.client, 'attach_receipt', { p_expense_id: expenseId, p_storage_path: path, p_sha256: '0'.repeat(64) }, 'trip_not_found')
  })

  it('Falscher Dateityp und zu grosse Dateien werden vom Server abgelehnt', async () => {
    const base = `${trip.tripId}/${expenseId}/`
    const html = await ef.client.storage
      .from('receipts')
      .upload(`${base}${randomUUID()}.html`, Buffer.from('<script>alert(1)</script>'), { contentType: 'text/html' })
    expect(html.error).not.toBeNull()
    const big = await ef.client.storage
      .from('receipts')
      .upload(`${base}${randomUUID()}.jpg`, Buffer.alloc(1_100_000, 1), { contentType: 'image/jpeg' })
    expect(big.error).not.toBeNull()
  })
})

describe('SEC-02: Realtime liefert keine fremden Reisedaten', () => {
  it('Nicht-Mitglied erhält keine Events, Mitglied schon', async () => {
    const received: Record<string, number> = { member: 0, outsider: 0 }
    const subscribe = (user: TestUser, key: string) =>
      new Promise<() => Promise<void>>((resolve) => {
        const channel = user.client
          .channel(`test-${key}-${randomUUID()}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `trip_id=eq.${trip.tripId}` }, () => {
            received[key]++
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') resolve(async () => void (await user.client.removeChannel(channel)))
          })
      })
    const stopMember = await subscribe(lg, 'member')
    const stopOutsider = await subscribe(mallory, 'outsider')
    await new Promise((r) => setTimeout(r, 1000))
    // Right after a fresh stack start the realtime server may need a moment: book until the member sees one.
    for (let attempt = 0; attempt < 5 && received.member === 0; attempt++) {
      await addExpense(ef, trip.tripId, { currency: 'EUR', minor: 100, participants: equal(trip.personIds.Larissa) })
      for (let i = 0; i < 20 && received.member === 0; i++) await new Promise((r) => setTimeout(r, 250))
    }
    await new Promise((r) => setTimeout(r, 1500))
    await stopMember()
    await stopOutsider()
    expect(received.member).toBeGreaterThan(0)
    expect(received.outsider).toBe(0)
  })
})
