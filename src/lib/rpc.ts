import { supabase } from './supabase'

/** Error raised by a TravelSplit RPC; `code` is the stable server error code. */
export class AppError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = 'AppError'
  }
}

const KNOWN_CODE = /^[a-z_]+$/

export function toAppError(error: { message?: string; code?: string } | Error | unknown): AppError {
  if (error instanceof AppError) return error
  const message = (error as { message?: string })?.message ?? ''
  if (KNOWN_CODE.test(message)) return new AppError(message)
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return new AppError('network_error', message)
  if (/out of range/i.test(message)) return new AppError('amount_too_large', message)
  return new AppError('unknown_error', message)
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw toAppError(error)
  return data as T
}
