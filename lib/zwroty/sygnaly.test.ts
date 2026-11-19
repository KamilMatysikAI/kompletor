import { describe, expect, it } from 'vitest'
import {
  EMPIK_REKLAMACJA,
  EMPIK_REKLAMACJA_ZAMKNIETA,
  EMPIK_ZWROT_PIENIEDZY,
  STATUSY_SYGNALOW,
  SYGNAL_LABEL,
  sygnalZwrotu,
  WOO_ZWROT_PIENIEDZY,
} from './sygnaly'

describe('sygnalZwrotu', () => {
  it('Woo: refunded = zwrot pieniędzy w kanale (nie „towar wrócił”); completed i inne = null', () => {
    for (const s of WOO_ZWROT_PIENIEDZY) expect(sygnalZwrotu('WOO', s)).toBe('ZWROT_PIENIEDZY')
    expect(sygnalZwrotu('WOO', 'refunded')).toBe('ZWROT_PIENIEDZY')
    expect(SYGNAL_LABEL.ZWROT_PIENIEDZY).toBe('zwrot pieniędzy w kanale')
    expect(sygnalZwrotu('WOO', 'completed')).toBeNull()
    expect(sygnalZwrotu('WOO', 'cancelled')).toBeNull()
    expect(sygnalZwrotu('WOO', 'REFUNDED')).toBeNull() // statusy porównywane dokładnie, jak w zapytaniu
  })

  it('Empik: każdy status z listy', () => {
    expect(sygnalZwrotu('EMPIK', 'REFUNDED')).toBe('ZWROT_PIENIEDZY')
    expect(sygnalZwrotu('EMPIK', 'WAITING_REFUND')).toBe('ZWROT_PIENIEDZY')
    expect(sygnalZwrotu('EMPIK', 'WAITING_REFUND_PAYMENT')).toBe('ZWROT_PIENIEDZY')
    expect(sygnalZwrotu('EMPIK', 'INCIDENT_OPEN')).toBe('REKLAMACJA')
    expect(sygnalZwrotu('EMPIK', 'INCIDENT_CLOSED')).toBe('REKLAMACJA_ZAMKNIETA')
    for (const s of [...EMPIK_ZWROT_PIENIEDZY, ...EMPIK_REKLAMACJA, ...EMPIK_REKLAMACJA_ZAMKNIETA]) expect(sygnalZwrotu('EMPIK', s)).not.toBeNull()
    expect(sygnalZwrotu('EMPIK', 'SHIPPED')).toBeNull()
    expect(sygnalZwrotu('EMPIK', 'CLOSED')).toBeNull()
  })

  it('Allegro: końcówka /RETURNED = zwrot; inne realizacje i sam status = null', () => {
    expect(sygnalZwrotu('ALLEGRO', 'READY_FOR_PROCESSING/RETURNED')).toBe('ZWROT')
    expect(sygnalZwrotu('ALLEGRO', 'READY_FOR_PROCESSING/SENT')).toBeNull()
    expect(sygnalZwrotu('ALLEGRO', 'READY_FOR_PROCESSING')).toBeNull()
    expect(sygnalZwrotu('ALLEGRO', 'RETURNED')).toBeNull()
  })

  it('nieznany status i kanał spoza listy = null', () => {
    expect(sygnalZwrotu('EMPIK', 'COS_NOWEGO')).toBeNull()
    expect(sygnalZwrotu('WOO', '')).toBeNull()
    expect(sygnalZwrotu('BL_INNE', 'refunded')).toBeNull()
    expect(sygnalZwrotu('EASYTOOLS', 'REFUNDED')).toBeNull()
    expect(sygnalZwrotu('RECZNE', 'INCIDENT_OPEN')).toBeNull()
  })

  it('lista do zapytania = statusy, które klasyfikacja rozpoznaje (jedno źródło)', () => {
    for (const [ch, list] of Object.entries(STATUSY_SYGNALOW)) {
      for (const s of list ?? []) expect(sygnalZwrotu(ch as 'WOO' | 'EMPIK', s)).not.toBeNull()
    }
    expect(Object.keys(STATUSY_SYGNALOW).sort()).toEqual(['EMPIK', 'WOO'])
  })
})
