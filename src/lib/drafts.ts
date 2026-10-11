// Offline drafts (R6, UX-04): an expense that could not reach the server is kept on this device only,
// shown as "not sent" and never counted in balances. Sending reuses the draft id as idempotency key,
// so a retry after a lost response can never book the expense twice.
import { useCallback, useEffect, useState } from 'react'
import { uploadReceipt } from './receipts'
import { rpc, toAppError } from './rpc'

export interface ExpenseArgs {
  p_title: string
  p_expense_date: string
  p_currency: string
  p_original_minor: string
  p_split_mode: string
  p_participants: { person_id: string; value: string | null }[]
  p_paid_by_person_id: string | null
  p_category: string | null
  p_note: string | null
}

export interface Draft {
  id: string
  /** Drafts belong to the signed-in user who wrote them; another account on this device never sends them. */
  userId: string
  tripId: string
  createdAt: string
  args: ExpenseArgs
  photo: Blob | null
  /** Set once the expense exists on the server and only the photo is still missing. */
  expenseId: string | null
  lastError: string | null
}

const DB_NAME = 'travelsplit'
const STORE = 'drafts'
const CHANGED = 'travelsplit:drafts-changed'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function saveDraft(draft: Draft): Promise<void> {
  await tx('readwrite', (s) => s.put(draft))
  window.dispatchEvent(new Event(CHANGED))
}

export async function deleteDraft(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
  window.dispatchEvent(new Event(CHANGED))
}

export async function listDrafts(userId: string, tripId?: string): Promise<Draft[]> {
  try {
    const all = await tx<Draft[]>('readonly', (s) => s.getAll())
    return all.filter((d) => d.userId === userId && (!tripId || d.tripId === tripId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    return []
  }
}

let syncing: Promise<number> | null = null

/** Sends all drafts; returns how many were completed. Safe to call repeatedly. */
export function syncDrafts(userId: string): Promise<number> {
  syncing ??= (async () => {
    let done = 0
    for (let draft of await listDrafts(userId)) {
      try {
        if (!draft.expenseId) {
          const expenseId = await rpc<string>('create_expense', { ...draft.args, p_trip_id: draft.tripId, p_idempotency_key: draft.id })
          draft = { ...draft, expenseId, lastError: null }
          if (draft.photo) await saveDraft(draft)
        }
        if (draft.photo) await uploadReceipt(draft.tripId, draft.expenseId!, draft.photo)
        await deleteDraft(draft.id)
        done++
      } catch (e) {
        const code = toAppError(e).code
        if (code === 'network_error') break
        await saveDraft({ ...draft, lastError: code })
      }
    }
    return done
  })().finally(() => {
    syncing = null
  })
  return syncing
}

export function useDrafts(userId: string | undefined, tripId: string | undefined) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const refresh = useCallback(async () => setDrafts(userId ? await listDrafts(userId, tripId) : []), [userId, tripId])
  useEffect(() => {
    void refresh()
    window.addEventListener(CHANGED, refresh)
    return () => window.removeEventListener(CHANGED, refresh)
  }, [refresh])
  return drafts
}
