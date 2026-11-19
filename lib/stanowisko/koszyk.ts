// Skan koszyka na stanowisku pakowania. Okno zamówienia otwarte: pusty koszyk = zamówienie trafia do niego
// (zbieranie do koszyka), koszyk innego zamówienia = przełączenie na tamto zamówienie. Pole skanu bez okna: koszyk z zamówieniem otwiera to zamówienie (jak skan karty). Klient
// bazy firmy z sesji (RLS): koszyk i zamówienie innej firmy są niewidoczne.
import type { PrismaClient } from '@prisma/client'
import { przypiszKoszyk, zawartoscKoszyka } from '@/lib/koszyki/koszyki'
import { otworzZSesji, type WynikSkanu } from './cwiczenie'
import { wczytajZamowienia } from './zamowienia'

type Db = PrismaClient

export type WynikSkanuKoszyka =
  | { typ: 'koszyk'; ton: 'ok' | 'info' | 'blad'; tekst: string; orderId: string | null; koszyk: string | null }
  | { typ: 'otworz'; wynik: WynikSkanu; koszyk: string }

const numer = async (db: Db, id: string) => (await wczytajZamowienia(db, [id]))[0]?.numer ?? 'inne zamówienie'

export async function skanKoszyka(db: Db, nazwa: string, biezace: string | null, kto: { userId: string }): Promise<WynikSkanuKoszyka> {
  const k = await zawartoscKoszyka(db, nazwa)
  if (!k) return { typ: 'koszyk', ton: 'blad', tekst: `Nie ma koszyka ${nazwa}. Koszyki firmy: Pakowanie → Koszyki.`, orderId: null, koszyk: null }
  if (biezace) {
    const w = await przypiszKoszyk(db, { nazwa: k.nazwa, orderId: biezace, userId: kto.userId })
    if (w.typ === 'przypisany') {
      const skad = w.przeniesionyZ ? ` (przeniesione z koszyka ${w.przeniesionyZ})` : ''
      return { typ: 'koszyk', ton: 'ok', tekst: `Koszyk ${w.nazwa}: ${await numer(db, biezace)}${skad}.`, orderId: biezace, koszyk: w.nazwa }
    }
    if (w.typ === 'wInnym') {
      return { typ: 'koszyk', ton: 'info', tekst: `To zamówienie przed chwilą trafiło do koszyka ${w.wKoszyku} na innym stanowisku. Koszyk ${w.nazwa} zostaje pusty.`, orderId: biezace, koszyk: w.wKoszyku }
    }
    if (w.typ === 'juz') return { typ: 'koszyk', ton: 'info', tekst: `To zamówienie już jest w koszyku ${w.nazwa}.`, orderId: biezace, koszyk: w.nazwa }
    // koszyk innego zamówienia = przełączenie na zamówienie z koszyka (jak skan jego karty). `przypiszKoszyk`
    // przy `zajety` niczego nie zapisuje, więc otwarte zamówienie zostaje tam, gdzie było (bez przeniesienia do cudzego koszyka).
    if (w.typ === 'zajety') return { typ: 'otworz', wynik: await otworzZSesji(db, w.orderId, null, kto), koszyk: w.nazwa }
    return { typ: 'koszyk', ton: 'blad', tekst: 'Nie udało się przypisać koszyka. Zamknij okno i otwórz zamówienie jeszcze raz.', orderId: null, koszyk: null }
  }
  if (!k.orderId) return { typ: 'koszyk', ton: 'info', tekst: `Koszyk ${k.nazwa} jest pusty. Zeskanuj kartę zamówienia, potem ten koszyk.`, orderId: null, koszyk: null }
  return { typ: 'otworz', wynik: await otworzZSesji(db, k.orderId, null, kto), koszyk: k.nazwa }
}
