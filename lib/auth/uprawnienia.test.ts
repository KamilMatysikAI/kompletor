import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, can, GRUPY_UPRAWNIEN, PERMISSIONS, permissionsOf } from './uprawnienia'
import { maZakazaneSlowo } from '../panel/slownik'
import { generatePassword, hashPassword, verifyPassword } from './hasla'

describe('role i uprawnienia', () => {
  it('właściciel ma wszystko, biuro podgląd i rozjazdy, magazyn tylko podgląd', () => {
    expect([...permissionsOf({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] })].sort()).toEqual([...ALL_PERMISSIONS].sort())
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'rozjazdy.podglad')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'zamowienia.anuluj_po_fakturze')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'panel.podglad')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'rozjazdy.podglad')).toBe(false)
    // „Przyjechał kurier” klika magazyn; ustawienia godzin odbioru tylko z uprawnieniem ustawień
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'pakowanie.kurier')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'ustawienia')).toBe(false)
  })

  it('stanowisko pakowania ma magazyn i właściciel, nie biuro; listę „Do poprawy” zamyka biuro', () => {
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'pakowanie.stanowisko')).toBe(true)
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'pakowanie.stanowisko')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'pakowanie.stanowisko')).toBe(false)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'pakowanie.do_poprawy')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'pakowanie.do_poprawy')).toBe(false)
  })

  it('dane klienta — właściciel i biuro pełny podgląd i skrót, magazyn tylko skrót', () => {
    for (const p of ['klienci.dane', 'klienci.skrot'] as const) {
      expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, p)).toBe(true)
      expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, p)).toBe(true)
    }
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'klienci.skrot')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'klienci.dane')).toBe(false)
  })

  it('akcje karty zamówienia — właściciel i biuro; magazyn tylko notatki', () => {
    for (const p of ['zamowienia.edycja_pozycji', 'zamowienia.podzial', 'zamowienia.notatki'] as const) {
      expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, p)).toBe(true)
      expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, p)).toBe(true)
      expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, p)).toBe(p === 'zamowienia.notatki')
    }
  })

  it('cena i VAT pozycji — tylko właściciel; biuru i magazynowi nadaje się osobno', () => {
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'zamowienia.ceny_pozycji')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'zamowienia.ceny_pozycji')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'zamowienia.ceny_pozycji')).toBe(false)
    expect(can({ role: 'BIURO', permissions: ['zamowienia.ceny_pozycji'], deniedPermissions: [] }, 'zamowienia.ceny_pozycji')).toBe(true)
  })

  it('dodawanie zamówień — właściciel i biuro; dowolny status — tylko właściciel (biuru nadaje się osobno)', () => {
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'zamowienia.dodawanie')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'zamowienia.dodawanie')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'zamowienia.dodawanie')).toBe(false)
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'zamowienia.status_dowolny')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'zamowienia.status_dowolny')).toBe(false)
    expect(can({ role: 'BIURO', permissions: ['zamowienia.status_dowolny'], deniedPermissions: [] }, 'zamowienia.status_dowolny')).toBe(true)
  })

  it('ręczne rozstrzygnięcie przesyłki — domyślnie tylko właściciel, biuru i magazynowi da się dołożyć', () => {
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'przesylki.rozstrzyganie')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'przesylki.rozstrzyganie')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'przesylki.rozstrzyganie')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: ['przesylki.rozstrzyganie'], deniedPermissions: [] }, 'przesylki.rozstrzyganie')).toBe(true)
  })

  it('raporty sprzedaży i marża: właściciel i biuro tak, magazyn tylko nadane osobno', () => {
    expect(can({ role: 'WLASCICIEL', permissions: [], deniedPermissions: [] }, 'raporty.sprzedaz')).toBe(true)
    expect(can({ role: 'BIURO', permissions: [], deniedPermissions: [] }, 'raporty.sprzedaz')).toBe(true)
    expect(can({ role: 'MAGAZYN', permissions: [], deniedPermissions: [] }, 'raporty.sprzedaz')).toBe(false)
    expect(can({ role: 'MAGAZYN', permissions: ['raporty.sprzedaz'], deniedPermissions: [] }, 'raporty.sprzedaz')).toBe(true)
  })

  it('dodatkowe uprawnienie osoby (np. anulowanie po fakturze dla biura) działa, nieznane nazwy nie dają nic', () => {
    const pracownik = { role: 'BIURO' as const, permissions: ['zamowienia.anuluj_po_fakturze', 'admin', 'ustawienia ', '__proto__'], deniedPermissions: [] }
    expect(can(pracownik, 'zamowienia.anuluj_po_fakturze')).toBe(true)
    expect(can(pracownik, 'ustawienia')).toBe(false)
    expect(permissionsOf(pracownik).size).toBe(17) // zwroty (przyjęcie i korekty); raporty sprzedaży; faktura na karcie, dodawanie zamówień ręcznych, podgląd, rozjazdy, „Przyjechał”, „Do poprawy”, decyzje o brakach, dane klienta i skrót, przejścia w PRACY, trzy akcje karty (nadanie i faktura dojdą z etapem 4–5) + anulowanie
  })
})

describe('hasła', () => {
  it('argon2id: weryfikacja dobrego i złego hasła, uszkodzony hash = false, za krótkie hasło odrzucone', async () => {
    const h = await hashPassword('dobre-haslo-123456')
    expect(h.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(h, 'dobre-haslo-123456')).toBe(true)
    expect(await verifyPassword(h, 'Dobre-haslo-123456')).toBe(false)
    expect(await verifyPassword('to-nie-hash', 'x')).toBe(false)
    await expect(hashPassword('krotkie')).rejects.toThrow(/12 znaków/)
  })

  it('hasło startowe: 20 znaków z alfabetu bez mylących znaków, za każdym razem inne', () => {
    const a = generatePassword()
    expect(a).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/)
    expect(generatePassword()).not.toBe(a)
  })
})

describe('grupy uprawnień na ekranie Użytkownicy', () => {
  it('każde uprawnienie w dokładnie jednej grupie', () => {
    const wszystkie = GRUPY_UPRAWNIEN.flatMap((g) => g.uprawnienia)
    expect([...wszystkie].sort()).toEqual([...ALL_PERMISSIONS].sort())
    expect(new Set(wszystkie).size).toBe(wszystkie.length)
  })
  it('opisy uprawnień bez słów wewnętrznych (cień, praca, na sucho…)', () => {
    for (const p of ALL_PERMISSIONS) expect(maZakazaneSlowo(PERMISSIONS[p]), p).toBeNull()
  })
})
