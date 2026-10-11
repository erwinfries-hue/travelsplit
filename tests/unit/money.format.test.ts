import { describe, expect, it } from 'vitest'
import { formatMoney, minorToDecimalString, parseRate, rateToString } from '../../src/domain/money'

describe('Formatierung', () => {
  it('formatiert exakt ohne Float-Umweg', () => {
    expect(minorToDecimalString(123456789012345678n, 'EUR')).toBe('1234567890123456.78')
    expect(minorToDecimalString(-5n, 'EUR')).toBe('-0.05')
    expect(formatMoney(128450n, 'EUR', 'de-DE')).toBe('1.284,50 €')
    expect(formatMoney(-1820n, 'EUR', 'en-GB')).toBe('-€18.20')
    expect(formatMoney(4250n, 'EUR', 'de-DE', { signed: true })).toBe('+42,50 €')
  })

  it('Kurs-Roundtrip mit 10 Nachkommastellen', () => {
    expect(rateToString(parseRate('0,0025'))).toBe('0.0025')
    expect(rateToString(parseRate('1.0000000001'))).toBe('1.0000000001')
    expect(() => parseRate('0')).toThrow()
    expect(() => parseRate('1.00000000001')).toThrow()
  })
})
