export type TripStatus = 'active' | 'archived'

export interface Trip {
  id: string
  title: string
  base_currency: string
  start_date: string | null
  end_date: string | null
  status: TripStatus
  admin_user_id: string
  version: number
  created_at: string
}

export interface Person {
  id: string
  display_name: string
  linked_user_id: string | null
  status: 'placeholder' | 'active' | 'removed'
}

export interface Rate {
  currency: string
  eur_per_unit: string
  revision: number
  rate_date: string | null
  updated_at: string
}

export interface Expense {
  id: string
  created_by: string
  paid_by_person_id: string
  title: string
  category: string | null
  note: string | null
  expense_date: string
  currency: string
  original_minor: number
  split_mode: 'equal' | 'fixed' | 'percent'
  source: string
  admin_reconstruction: boolean
  revision: number
  created_at: string
  deleted_at: string | null
}

export interface Split {
  expense_id: string
  person_id: string
  original_minor: number
  input_value: number | null
}

export interface BaseShare {
  expense_id: string
  paid_by_person_id: string
  base_total: number
  person_id: string
  base_minor: number
}

export interface Settlement {
  id: string
  sender_person_id: string
  receiver_person_id: string
  currency: string
  original_minor: number
  note: string | null
  status: 'pending' | 'confirmed' | 'rejected' | 'withdrawn'
  created_at: string
  decided_at: string | null
  confirmed_base_minor: number | null
  confirmed_base_currency: string | null
  confirmed_from_rate: string | null
  confirmed_base_rate: string | null
  confirmed_at: string | null
}

export interface Reversal {
  id: string
  settlement_id: string
  reason: string
  reversed_base_minor: number
  created_at: string
}

export interface Receipt {
  expense_id: string
  storage_path: string
  size_bytes: number
  created_by: string
}

export interface TripData {
  trip: Trip
  people: Person[]
  rates: Rate[]
  expenses: Expense[]
  splits: Split[]
  baseShares: BaseShare[]
  balances: Map<string, bigint>
  settlements: Settlement[]
  reversals: Reversal[]
  receipts: Receipt[]
  myPersonId: string | null
  isAdmin: boolean
}
