// treść błędu faktury na konsoli bez argumentów zapytania.
import { describe, expect, it } from 'vitest'
import { opisBledu } from './podglad'

describe('opisBledu', () => {
  it('błąd Prismy tylko z nazwy i kodu', () => {
    const e = Object.assign(new Error('Invalid invocation: { data: { orderNumber: "Z-1" } }'), { name: 'PrismaClientKnownRequestError', code: 'P2002' })
    expect(opisBledu(e)).toBe('PrismaClientKnownRequestError P2002')
    expect(opisBledu(Object.assign(new Error('args'), { name: 'PrismaClientValidationError' }))).toBe('PrismaClientValidationError')
  })

  it('zwykły błąd obcięty do 300 znaków', () => {
    expect(opisBledu(new Error('x'.repeat(500)))).toHaveLength(300)
    expect(opisBledu('coś')).toBe('coś')
  })
})
