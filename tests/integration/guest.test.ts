// R6 / SEC-08: guest access, loss of the guest session and upgrade to Google.
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { addExpense, balances, closeDb, createGuest, createUser, db, equal, rpc, rpcFails, setupTrip } from './helpers'

afterAll(closeDb)

/** What GoTrue does on linkIdentity(google) for an anonymous user: same id, no longer anonymous, Google identity added. */
async function simulateGoogleLink(userId: string) {
  const email = `upgraded-${randomUUID().slice(0, 8)}@test.travelsplit.local`
  await db().query(`update auth.users set is_anonymous = false, email = $2, email_confirmed_at = now() where id = $1`, [userId, email])
  await db().query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, $3, 'google', now(), now(), now())`,
    [`google-${userId}`, userId, JSON.stringify({ sub: `google-${userId}`, email, email_verified: true })],
  )
}

describe('Gastzugang', () => {
  it('SEC-08: verlorene Gastsitzung gibt keinen Zugriff zurück, auch nicht über denselben Namen oder Link', async () => {
    const admin = await createUser('Erwin', { creator: true })
    const guest = await createGuest('Larissa')
    const { tripId } = await setupTrip(admin, [])
    const personId = await rpc<string>(admin.client, 'add_trip_person', { p_trip_id: tripId, p_display_name: 'Larissa' })
    const inv = await rpc<{ token: string }>(admin.client, 'create_invitation', { p_person_id: personId })
    await rpc(guest.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Larissa' })

    // The browser data is gone: a new anonymous session with the same name and the same link.
    const again = await createGuest('Larissa')
    await rpcFails(again.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Larissa' }, 'invitation_used')
    const { data: trips } = await again.client.from('trips').select('id').eq('id', tripId)
    expect(trips).toEqual([])
    await rpcFails(again.client, 'trip_balances', { p_trip_id: tripId }, 'trip_not_found')
  })

  it('R6: Gast → Google behält Mitgliedschaft und Buchungen und darf danach Reiseleitung werden', async () => {
    const admin = await createUser('Erwin', { creator: true })
    const guest = await createGuest('Roger')
    const { tripId, personIds } = await setupTrip(admin, [guest])
    await addExpense(guest, tripId, { currency: 'EUR', minor: 6000, participants: equal(personIds.Erwin, personIds.Roger) })
    const before = await balances(admin, tripId)

    await rpcFails(admin.client, 'transfer_admin', { p_trip_id: tripId, p_new_admin_person_id: personIds.Roger }, 'admin_requires_google')
    expect(await rpc(guest.client, 'my_capabilities')).toMatchObject({ is_anonymous: true, has_google: false })

    await simulateGoogleLink(guest.id)
    const { error } = await guest.client.auth.refreshSession()
    expect(error).toBeNull()

    expect(await rpc(guest.client, 'my_capabilities')).toEqual({ is_anonymous: false, has_google: true, can_create_trips: false })
    expect(await balances(guest, tripId)).toEqual(before)
    const { data: me } = await guest.client.from('trip_people').select('id').eq('trip_id', tripId).eq('linked_user_id', guest.id).single()
    expect(me!.id).toBe(personIds.Roger)

    await rpc(admin.client, 'transfer_admin', { p_trip_id: tripId, p_new_admin_person_id: personIds.Roger })
    const { data: trip } = await guest.client.from('trips').select('admin_user_id').eq('id', tripId).single()
    expect(trip!.admin_user_id).toBe(guest.id)
  })

  it('Ein Gast darf auch nach dem Upgrade ohne Freigabe keine Reise erstellen', async () => {
    const guest = await createGuest('Gast')
    await simulateGoogleLink(guest.id)
    await guest.client.auth.refreshSession()
    await rpcFails(guest.client, 'create_trip', { p_title: 'X', p_base_currency: 'EUR', p_admin_display_name: 'Gast' }, 'creator_not_allowed')
  })
})

describe('Betreiber-Recovery (R11)', () => {
  it('Kein Mitglied kann sich selbst zur Reiseleitung machen; nur der Betreiber per SQL, mit Begründung und Audit', async () => {
    const admin = await createUser('Erwin', { creator: true })
    const member = await createUser('Larissa', { google: true })
    const guest = await createGuest('Gast')
    const { tripId } = await setupTrip(admin, [member, guest])

    // The API offers no way to call operator functions, not even for members.
    const { error } = await member.client.rpc('operator_recover_admin', {
      p_trip_id: tripId, p_new_admin_user_id: member.id, p_operator_note: 'Ich bin jetzt Admin, bitte',
    })
    expect(error).not.toBeNull()
    const { error: schemaError } = await member.client.schema('private').rpc('operator_recover_admin', {
      p_trip_id: tripId, p_new_admin_user_id: member.id, p_operator_note: 'Ich bin jetzt Admin, bitte',
    })
    expect(schemaError).not.toBeNull()

    await expect(db().query(`select private.operator_recover_admin($1, $2, 'kurz')`, [tripId, member.id])).rejects.toThrow(/operator note/)
    await expect(
      db().query(`select private.operator_recover_admin($1, $2, 'Telefonisch mit Erwin geprüft')`, [tripId, guest.id]),
    ).rejects.toThrow(/Google/)

    await db().query(`select private.operator_recover_admin($1, $2, 'Erwin hat Google-Konto verloren, per Telefon bestätigt')`, [tripId, member.id])
    const { data: trip } = await member.client.from('trips').select('admin_user_id').eq('id', tripId).single()
    expect(trip!.admin_user_id).toBe(member.id)
    const { data: audit } = await member.client.from('audit_events').select('action, actor_user_id').eq('trip_id', tripId).eq('action', 'operator.admin_recovered')
    expect(audit).toEqual([{ action: 'operator.admin_recovered', actor_user_id: null }])
  })
})
