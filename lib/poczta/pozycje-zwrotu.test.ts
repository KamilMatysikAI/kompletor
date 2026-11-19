// Pozycje maila o zwrocie: nazwy z pozycji zamówienia (nazwa ze sklepu), zestaw jako jedna pozycja, część zestawu
// jako składniki, te same nazwy zsumowane. Czysta funkcja, bez bazy.
import { describe, expect, it } from 'vitest'
import { pozycjeZwrotu } from './wysylka'

const KSIEGOWE: Record<string, string> = { zestaw: 'ZEST-01 zestaw prezentowy', a: 'KB-A kubek A', b: 'KB-B kubek B', c: 'KB-C kubek C' }
const nazwa = (id: string) => KSIEGOWE[id] ?? null
const skladniki = (id: string) =>
  id === 'zestaw'
    ? [
        { productId: 'a', perUnit: 1 },
        { productId: 'b', perUnit: 2 },
      ]
    : [{ productId: id, perUnit: 1 }]

describe('pozycje maila o zwrocie', () => {
  it('pozycja produktu: nazwa ze sklepu zamiast księgowej, ilość w sztukach', () => {
    const poz = new Map([['l1', { productId: 'c', channelName: 'Kubek C ze sklepu 100 g' }]])
    expect(pozycjeZwrotu([{ orderLineId: 'l1', productId: 'c', qty: 2 }], poz, skladniki, nazwa)).toEqual([{ nazwa: 'Kubek C ze sklepu 100 g', ilosc: 2 }])
  })

  it('cały zestaw: jedna pozycja z nazwą zestawu ze sklepu i liczbą zestawów, bez składników', () => {
    const poz = new Map([['l1', { productId: 'zestaw', channelName: 'Zestaw prezentowy 3 kubki' }]])
    const linie = [
      { orderLineId: 'l1', productId: 'a', qty: 2 },
      { orderLineId: 'l1', productId: 'b', qty: 4 },
    ]
    expect(pozycjeZwrotu(linie, poz, skladniki, nazwa)).toEqual([{ nazwa: 'Zestaw prezentowy 3 kubki', ilosc: 2 }])
  })

  it('część zestawu: składniki z nazwą księgową; pozycja bez nazwy ze sklepu: nazwa księgowa', () => {
    const poz = new Map([
      ['l1', { productId: 'zestaw', channelName: 'Zestaw prezentowy 3 kubki' }],
      ['l2', { productId: 'c', channelName: null }],
    ])
    const linie = [
      { orderLineId: 'l1', productId: 'b', qty: 1 },
      { orderLineId: 'l2', productId: 'c', qty: 1 },
    ]
    expect(pozycjeZwrotu(linie, poz, skladniki, nazwa)).toEqual([
      { nazwa: 'KB-B kubek B', ilosc: 1 },
      { nazwa: 'KB-C kubek C', ilosc: 1 },
    ])
  })

  it('składniki nie w proporcji zestawu: składniki, nie zestaw', () => {
    const poz = new Map([['l1', { productId: 'zestaw', channelName: 'Zestaw prezentowy 3 kubki' }]])
    const linie = [
      { orderLineId: 'l1', productId: 'a', qty: 1 },
      { orderLineId: 'l1', productId: 'b', qty: 1 },
    ]
    expect(pozycjeZwrotu(linie, poz, skladniki, nazwa)).toEqual([
      { nazwa: 'KB-A kubek A', ilosc: 1 },
      { nazwa: 'KB-B kubek B', ilosc: 1 },
    ])
  })

  it('dwie pozycje zamówienia z tą samą nazwą: jedna pozycja maila z sumą', () => {
    const poz = new Map([
      ['l1', { productId: 'c', channelName: 'Kubek C' }],
      ['l2', { productId: 'c', channelName: 'Kubek C' }],
    ])
    const linie = [
      { orderLineId: 'l1', productId: 'c', qty: 1 },
      { orderLineId: 'l2', productId: 'c', qty: 2 },
    ]
    expect(pozycjeZwrotu(linie, poz, skladniki, nazwa)).toEqual([{ nazwa: 'Kubek C', ilosc: 3 }])
  })
})
