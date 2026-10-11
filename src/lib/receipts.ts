import { sha256Hex } from './image'
import { newId } from './ids'
import { rpc, toAppError } from './rpc'
import { supabase } from './supabase'

const BUCKET = 'receipts'
/** Signed URLs are short-lived so a forwarded link stops working quickly. */
export const SIGNED_URL_SECONDS = 60

/** Uploads an already compressed JPEG and makes it the expense's receipt; the previous file is removed. */
export async function uploadReceipt(tripId: string, expenseId: string, jpeg: Blob): Promise<void> {
  const path = `${tripId}/${expenseId}/${newId()}.jpg`
  const { error } = await supabase.storage.from(BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: false })
  if (error) throw toAppError(error)
  let previous: string | null
  try {
    previous = await rpc<string | null>('attach_receipt', { p_expense_id: expenseId, p_storage_path: path, p_sha256: await sha256Hex(jpeg) })
  } catch (e) {
    await supabase.storage.from(BUCKET).remove([path])
    throw e
  }
  if (previous) await supabase.storage.from(BUCKET).remove([previous])
}

export async function removeReceipt(expenseId: string): Promise<void> {
  const path = await rpc<string | null>('detach_receipt', { p_expense_id: expenseId })
  if (path) await supabase.storage.from(BUCKET).remove([path])
}

export async function receiptUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS)
  if (error) throw toAppError(error)
  return data.signedUrl
}
