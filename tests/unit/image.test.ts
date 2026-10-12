import { describe, expect, it } from 'vitest'
import { COMPRESSION_STEPS, fitWithin, RECEIPT_MAX_EDGE } from '../../src/lib/image'

describe('fitWithin', () => {
  it('verkleinert die längere Kante auf das Maximum und behält das Seitenverhältnis', () => {
    expect(fitWithin(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 })
    expect(fitWithin(3000, 4000, 2560)).toEqual({ width: 1920, height: 2560 })
  })
  it('vergrössert nie', () => {
    expect(fitWithin(800, 600, 2560)).toEqual({ width: 800, height: 600 })
  })
  it('erste Stufe respektiert die Obergrenze 2560 px, Qualität sinkt monoton', () => {
    expect(COMPRESSION_STEPS[0].maxEdge).toBe(RECEIPT_MAX_EDGE)
    for (let i = 1; i < COMPRESSION_STEPS.length; i++) {
      expect(COMPRESSION_STEPS[i].maxEdge).toBeLessThan(COMPRESSION_STEPS[i - 1].maxEdge)
      expect(COMPRESSION_STEPS[i].quality).toBeLessThan(COMPRESSION_STEPS[i - 1].quality)
    }
  })
})
