'use server'
// Akcje listy przesyłek: druk etykiet na stanowisku i anulowanie przesyłek u przewoźnika. Sesja
// i uprawnienie na wejściu, identyfikatory przesyłek z formularza albo z filtrów („na wszystkich stronach”, liczone na
// serwerze), kolejność jak na liście. Poniżej progu od razu (raport w toaście), od progu w tle (postęp nad listą).
import { revalidatePath } from 'next/cache'
import { requireSession } from '@/lib/panel/kontekst'
import { sortZ } from '@/lib/panel/tabela'
import { filtryPrzesylekZ, idPrzesylek, idPrzesylekZ, SORT_PRZESYLEK, SORT_PRZESYLEK_DOMYSLNY } from '@/lib/wysylka/lista'
import {
  bladParametrowPrzesylek,
  MAKS_PRZESYLEK,
  NAZWA_AKCJI_PRZESYLEK,
  PROG_TLA_PRZESYLEK,
  RODZAJE_PRZESYLEK,
  UPRAWNIENIE_PRZESYLEK,
  wykonajPrzesylkiOdRazu,
  zlecPrzesylkiWTle,
  type ParametryPrzesylek,
  type RodzajPrzesylek,
} from '@/lib/wysylka/masowo'
import type { WynikPozycji } from '@/lib/zamowienia/masowo'

export interface StanAkcjiPrzesylek {
  ok?: boolean
  komunikat: string | null
  wTle?: string
  bledy?: WynikPozycji[]
  n?: number
}

/** „1 przesyłki”, „2 przesyłek”: dopełniacz po „dla” i „z” ma przy liczbie 1 liczbę pojedynczą. */
const przesylek = (n: number): string => `${n} ${n === 1 ? 'przesyłki' : 'przesyłek'}`

function zdanie(rodzaj: RodzajPrzesylek, ok: number, bledy: number): string {
  const nazwa = NAZWA_AKCJI_PRZESYLEK[rodzaj]
  if (!bledy) return `${nazwa}: gotowe dla ${przesylek(ok)}.`
  if (!ok) return bledy === 1 ? `${nazwa}: nie udało się (powód pod paskiem).` : `${nazwa}: nie udało się dla żadnej z ${przesylek(bledy)} (powody pod paskiem).`
  return `${nazwa}: ${ok} gotowe, ${bledy} pominięte (powody pod paskiem).`
}

export async function akcjaPrzesylek(poprzedni: StanAkcjiPrzesylek, form: FormData): Promise<StanAkcjiPrzesylek> {
  const ctx = await requireSession()
  const n = (poprzedni.n ?? 0) + 1
  const rodzaj = String(form.get('rodzaj') ?? '') as RodzajPrzesylek
  if (!RODZAJE_PRZESYLEK.includes(rodzaj)) return { ok: false, komunikat: 'Nieznana akcja.', n }
  if (!ctx.permissions.has(UPRAWNIENIE_PRZESYLEK)) return { ok: false, komunikat: 'Nie masz uprawnienia do tej akcji (Ustawienia → Zespół i dostęp → Użytkownicy i uprawnienia).', n }
  let ids: string[]
  if (form.get('wszystkie') === 'tak') {
    const sp = Object.fromEntries([...new URLSearchParams(String(form.get('filtry') ?? '')).entries()])
    const r = await idPrzesylek(ctx.db, filtryPrzesylekZ(sp), sortZ(sp, SORT_PRZESYLEK, SORT_PRZESYLEK_DOMYSLNY), MAKS_PRZESYLEK + 1)
    if (r.razem > MAKS_PRZESYLEK) return { ok: false, komunikat: `${NAZWA_AKCJI_PRZESYLEK[rodzaj]}: najwyżej ${MAKS_PRZESYLEK} przesyłek w jednej akcji, zawęź filtry (pasuje ${r.razem}).`, n }
    ids = r.ids
  } else {
    const z = idPrzesylekZ(form.getAll('zaznaczone'), MAKS_PRZESYLEK)
    if (z.zaDuzo) return { ok: false, komunikat: `${NAZWA_AKCJI_PRZESYLEK[rodzaj]}: najwyżej ${MAKS_PRZESYLEK} przesyłek w jednej akcji.`, n }
    ids = z.ids
  }
  if (!ids.length) return { ok: false, komunikat: 'Nie zaznaczono żadnej przesyłki.', n }
  const p: ParametryPrzesylek = { stanowisko: String(form.get('stanowisko') ?? '') || null, klucz: String(form.get('klucz') ?? '') || null }
  const blad = bladParametrowPrzesylek(rodzaj, p, { odRazu: ids.length < PROG_TLA_PRZESYLEK })
  if (blad) return { ok: false, komunikat: blad, n }
  if (ids.length >= PROG_TLA_PRZESYLEK) {
    const id = await zlecPrzesylkiWTle(ctx.db, rodzaj, p, ids, ctx.user.id)
    revalidatePath('/przesylki')
    return { ok: true, komunikat: `${NAZWA_AKCJI_PRZESYLEK[rodzaj]} dla ${ids.length} przesyłek idzie w tle. Postęp i raport nad listą.`, wTle: id, n }
  }
  const w = await wykonajPrzesylkiOdRazu(ctx.db, rodzaj, p, ids, { id: ctx.user.id, uprawnienia: ctx.permissions })
  revalidatePath('/przesylki')
  return { ok: w.bledy === 0, komunikat: zdanie(rodzaj, w.ok, w.bledy), bledy: w.pozycje.filter((x) => !x.ok).slice(0, 20), n }
}
