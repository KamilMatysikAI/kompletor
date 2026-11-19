'use server'
// „Kopiuj dane” na karcie zamówienia: adres dostawy, e-mail i telefon. Każde kopiowanie to osobny odczyt
// `daneKlienta(..., cel: KOPIA)` (uprawnienie `klienci.dane` sprawdzane drugi raz po stronie serwera, wpis w dzienniku
// podglądów). Tekst wraca tylko do przeglądarki osoby; komunikaty bez danych klienta.
import { ID_RE } from '@/lib/karta/bramka'
import { daneKlienta } from '@/lib/klienci/odczyt'
import { KOMUNIKAT_BRAK_KLUCZA } from '@/lib/klienci/szyfr'
import { adresDoKopii } from '@/lib/klienci/walidacja'
import { requirePermission } from '@/lib/panel/kontekst'

type WynikKopii = { tekst: string | null; blad: string | null }

const CO = { adres: 'adresu dostawy', email: 'e-maila', telefon: 'telefonu' } as const

export async function kopiujDaneKlienta(orderId: string, co: string): Promise<WynikKopii> {
  const ctx = await requirePermission('klienci.dane')
  const id = String(orderId ?? '')
  if (!ID_RE.test(id)) return { tekst: null, blad: 'Nie ma takiego zamówienia.' }
  if (co !== 'adres' && co !== 'email' && co !== 'telefon') return { tekst: null, blad: 'Nieznane dane do skopiowania.' }
  const d = await daneKlienta(ctx.db, id, { actorId: ctx.user.id, zakres: 'PELNY', cel: 'KOPIA' })
  const brak: WynikKopii = { tekst: null, blad: d.stan === 'BRAK_KLUCZA' ? KOMUNIKAT_BRAK_KLUCZA : `Brak ${CO[co]} do skopiowania.` }
  if (d.stan !== 'PELNY') return brak
  const tekst = co === 'adres' ? adresDoKopii(d.rekord) : co === 'email' ? d.rekord.email : d.rekord.telefon
  return tekst ? { tekst, blad: null } : brak
}
