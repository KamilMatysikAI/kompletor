// Szablony maili firmy (Ustawienia → Poczta → Szablony): odczyt nadpisań, zapis z walidacją i AuditLog,
// przywrócenie treści domyślnej, podgląd z danymi fikcyjnymi. Edytor zmienia teksty bloków szablonu domyślnego
// (akapity, etykiety, nagłówki list, wiersze szczegółów); układ, adresy przycisków i warunki zostają z kodu, więc
// firma nie zepsuje struktury maila ani nie wstawi własnego linku. Zmienne {{…}} sprawdza silnik (lib/maile/silnik.ts).
import type { Prisma, PrismaClient } from '@prisma/client'
import { renderujMail, sprawdzNadpisanie, SZABLONY_DOMYSLNE, type Blok, type GotowyMail, type NadpisaniaSzablonow, type NadpisanieSzablonu, type RodzajMaila } from '../maile'
import { DANE_PRZYKLADOWE, KONTEKST_PRZYKLADOWY } from '../maile/przyklady'
import { scalNadpisanie, ZMIENNE_WSPOLNE } from '../maile/silnik'

export const AUDIT_SZABLON = 'MailTemplate'

/** Szablony do edycji w panelu (reset hasła i zaproszenie nie: tekst bezpieczeństwa zostaje z kodu). */
export const RODZAJE_EDYTOWALNE = [
  'brak-platnosci',
  'nieudana-platnosc',
  'faktura',
  'gotowe-do-odbioru',
  'blad-faktury',
  'niski-stan',
  'zwrot-przyjety',
  'reklamacja-przyjeta',
  'zwrot-pieniedzy',
] as const satisfies readonly RodzajMaila[]
export type RodzajEdytowalny = (typeof RODZAJE_EDYTOWALNE)[number]

export const NAZWA_SZABLONU: Record<RodzajMaila, string> = {
  'brak-platnosci': 'Brak płatności',
  'nieudana-platnosc': 'Nieudana płatność online',
  faktura: 'Wysłane z fakturą',
  'gotowe-do-odbioru': 'Gotowe do odbioru',
  'blad-faktury': 'Błąd faktury (do biura)',
  'niski-stan': 'Niski stan (do biura)',
  'reset-hasla': 'Reset hasła',
  zaproszenie: 'Zaproszenie do firmy',
  'zwrot-przyjety': 'Zwrot dotarł',
  'reklamacja-przyjeta': 'Reklamacja dotarła',
  'zwrot-pieniedzy': 'Pieniądze zwrócone',
}

export function isRodzajEdytowalny(v: string): v is RodzajEdytowalny {
  return (RODZAJE_EDYTOWALNE as readonly string[]).includes(v)
}

export class BladSzablonuFirmy extends Error {}

function nadpisanieZWiersza(r: { subject: string | null; preheader: string | null; heading: string | null; blocks: Prisma.JsonValue | null }): NadpisanieSzablonu {
  const n: NadpisanieSzablonu = {}
  if (r.subject) n.temat = r.subject
  if (r.preheader) n.podglad = r.preheader
  if (r.heading) n.naglowek = r.heading
  if (Array.isArray(r.blocks) && r.blocks.length) n.bloki = r.blocks as unknown as Blok[]
  return n
}

/** Nadpisania firmy do renderu (wiersz z błędną treścią pomijany: lepiej treść domyślna niż brak maila). */
export async function nadpisaniaFirmy(db: PrismaClient): Promise<NadpisaniaSzablonow> {
  const rows = await db.mailTemplate.findMany()
  const out: NadpisaniaSzablonow = {}
  for (const r of rows) {
    if (!Object.hasOwn(SZABLONY_DOMYSLNE, r.kind)) continue
    const rodzaj = r.kind as RodzajMaila
    const n = nadpisanieZWiersza(r)
    if (sprawdzNadpisanie(rodzaj, n).length === 0) out[rodzaj] = n
  }
  return out
}

// ─── Edytor ─────────────────────────────────────────────────────────────────

export interface PoleEdytora {
  nazwa: string // nazwa pola formularza
  etykieta: string
  wartosc: string
  wielolinijkowe: boolean
}

export interface WidokSzablonu {
  rodzaj: RodzajEdytowalny
  nazwa: string
  odbiorca: 'klient' | 'biuro'
  zmieniony: boolean
  zmienionyKiedy: Date | null
  temat: string
  podglad: string
  naglowek: string
  pola: PoleEdytora[]
  zmienne: { nazwa: string; opis: string; wymagana: boolean }[]
}

const ETYKIETA_BLOKU: Record<Blok['typ'], string> = { akapit: 'Akapit', uwaga: 'Ważna informacja', kod: 'Treść techniczna', przycisk: 'Przycisk', lista: 'Lista', szczegoly: 'Szczegóły' }

function polaBlokow(bloki: Blok[]): PoleEdytora[] {
  const pola: PoleEdytora[] = []
  bloki.forEach((b, i) => {
    const nr = `${i + 1}. ${ETYKIETA_BLOKU[b.typ]}${b.jesli ? ` (gdy jest ${b.jesli})` : ''}`
    switch (b.typ) {
      case 'akapit':
      case 'uwaga':
      case 'kod':
        pola.push({ nazwa: `b${i}_tekst`, etykieta: nr, wartosc: b.tekst, wielolinijkowe: true })
        break
      case 'przycisk':
        pola.push({ nazwa: `b${i}_etykieta`, etykieta: `${nr}: napis`, wartosc: b.etykieta, wielolinijkowe: false })
        break
      case 'lista':
        pola.push({ nazwa: `b${i}_naglowek`, etykieta: `${nr}: nagłówek ({{${b.zmienna}}})`, wartosc: b.naglowek ?? '', wielolinijkowe: false })
        break
      case 'szczegoly':
        b.wiersze.forEach((w, j) => {
          pola.push({ nazwa: `b${i}_w${j}_etykieta`, etykieta: `${nr}, wiersz ${j + 1}: etykieta`, wartosc: w.etykieta, wielolinijkowe: false })
          pola.push({ nazwa: `b${i}_w${j}_wartosc`, etykieta: `${nr}, wiersz ${j + 1}: wartość`, wartosc: w.wartosc, wielolinijkowe: false })
        })
        break
    }
  })
  return pola
}

export async function widokSzablonu(db: PrismaClient, rodzaj: RodzajEdytowalny): Promise<WidokSzablonu> {
  const row = await db.mailTemplate.findFirst({ where: { kind: rodzaj } })
  const def = scalNadpisanie(SZABLONY_DOMYSLNE[rodzaj], row ? nadpisanieZWiersza(row) : null)
  return {
    rodzaj,
    nazwa: NAZWA_SZABLONU[rodzaj],
    odbiorca: def.odbiorca,
    zmieniony: !!row,
    zmienionyKiedy: row?.updatedAt ?? null,
    temat: def.temat,
    podglad: def.podglad,
    naglowek: def.naglowek,
    pola: polaBlokow(def.bloki),
    zmienne: Object.entries({ ...def.zmienne, ...ZMIENNE_WSPOLNE }).map(([nazwa, o]) => ({ nazwa, opis: o.opis, wymagana: o.wymagana })),
  }
}

/** Formularz edytora → nadpisanie: teksty z formularza na strukturze szablonu domyślnego. */
export function nadpisanieZFormularza(rodzaj: RodzajEdytowalny, form: FormData): NadpisanieSzablonu {
  const s = (k: string) => (form.get(k) === null ? null : String(form.get(k)).replace(/\r\n/g, '\n').slice(0, 2000))
  const def = SZABLONY_DOMYSLNE[rodzaj]
  const bloki: Blok[] = def.bloki.map((b, i): Blok => {
    switch (b.typ) {
      case 'akapit':
      case 'uwaga':
      case 'kod':
        return { ...b, tekst: s(`b${i}_tekst`) ?? b.tekst }
      case 'przycisk':
        return { ...b, etykieta: s(`b${i}_etykieta`) || b.etykieta }
      case 'lista': {
        const n = s(`b${i}_naglowek`)
        return n === null ? b : n.trim() ? { ...b, naglowek: n } : { typ: 'lista', zmienna: b.zmienna, ...(b.jesli ? { jesli: b.jesli } : {}) }
      }
      case 'szczegoly':
        return { ...b, wiersze: b.wiersze.map((w, j) => ({ ...w, etykieta: s(`b${i}_w${j}_etykieta`) || w.etykieta, wartosc: s(`b${i}_w${j}_wartosc`) || w.wartosc })) }
    }
  })
  return { temat: s('temat') ?? def.temat, podglad: s('podglad') ?? def.podglad, naglowek: s('naglowek') ?? def.naglowek, bloki }
}

export async function zapiszSzablon(db: PrismaClient, rodzaj: RodzajEdytowalny, n: NadpisanieSzablonu, actorId: string): Promise<void> {
  const bledy = sprawdzNadpisanie(rodzaj, n)
  // pusty temat albo nagłówek zostałby po cichu zastąpiony domyślnym: lepiej powiedzieć wprost
  if (!n.temat?.trim()) bledy.push('temat: nie może być pusty')
  if (!n.naglowek?.trim()) bledy.push('nagłówek: nie może być pusty')
  if (!(n.bloki ?? []).some((b) => (b.typ === 'akapit' || b.typ === 'uwaga') && b.tekst.trim())) bledy.push('treść: przynajmniej jeden akapit musi mieć tekst')
  if (bledy.length) throw new BladSzablonuFirmy(bledy.join('; '))
  // podgląd z danymi fikcyjnymi musi się wyrenderować (np. zmienna wymagana użyta poza sekcją)
  podgladSzablonu(rodzaj, n)
  await db.$transaction(async (tx) => {
    const organizationId = (await tx.organization.findFirstOrThrow({ select: { id: true } })).id
    const data = { subject: n.temat ?? null, preheader: n.podglad ?? null, heading: n.naglowek ?? null, blocks: (n.bloki ?? null) as unknown as Prisma.InputJsonValue, updatedById: actorId }
    await tx.mailTemplate.upsert({ where: { organizationId_kind: { organizationId, kind: rodzaj } }, create: { kind: rodzaj, ...data }, update: data })
    await tx.auditLog.create({ data: { entity: AUDIT_SZABLON, entityId: rodzaj, actorId, after: { temat: n.temat ?? null, naglowek: n.naglowek ?? null } } })
  })
}

export async function przywrocDomyslny(db: PrismaClient, rodzaj: RodzajEdytowalny, actorId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const r = await tx.mailTemplate.deleteMany({ where: { kind: rodzaj } })
    if (r.count) await tx.auditLog.create({ data: { entity: AUDIT_SZABLON, entityId: rodzaj, actorId, after: { przywrocono: 'treść domyślna' } } })
  })
}

/** Podgląd z danymi fikcyjnymi (lib/maile/przyklady.ts); `n` = treść z formularza przed zapisem. */
export function podgladSzablonu(rodzaj: RodzajEdytowalny, n?: NadpisanieSzablonu | null): GotowyMail {
  return renderujMail(rodzaj, KONTEKST_PRZYKLADOWY, DANE_PRZYKLADOWE[rodzaj], { nadpisania: { firma: n ? { [rodzaj]: n } : null } })
}
