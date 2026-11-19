// Lista faktur i korekt (jak „Faktury i paragony” w BaseLinkerze). Jeden odczyt ze wszystkich
// programów: wFirma (próby `InvoiceAttempt`, korekty przy zwrotach `Return.correction*`) i KSeF bezpośrednio
// (`KsefInvoiceDraft`: faktury VAT i korekty KOR). Klient bazy firmy (RLS), tylko odczyt.
//
// Nabywca: lista nie odszyfrowuje danych klientów (masowy odczyt danych osobowych bez potrzeby); kolumna mówi „firma”
// albo „osoba prywatna”, a filtr „nabywca” szuka po e-mailu albo telefonie skrótem (jak wyszukiwarka zamówień,
// lib/klienci/odczyt.ts), nazwisk nie przeszukujemy. Pełne dane nabywcy są na karcie zamówienia i w PDF.
import type { PrismaClient } from '@prisma/client'
import type { Ton } from '../panel/statusy'
import { STATUS_KSEF_LABEL, type StatusKsef } from '../ksef/szkice'
import { fromWarsaw, toWarsaw } from '../rdzen/kalendarz'

export type ZakladkaFaktur = 'faktury' | 'korekty'
export type StanDokumentu = 'WYSTAWIONA' | 'W_KOLEJCE' | 'BLAD' | 'SZKIC' | 'POZA_KSEF'

export interface WierszFaktury {
  /** Klucz akcji: `w:<próba>` (wFirma), `k:<wiersz KSeF>`, `z:<zwrot>` (korekta wFirmy). */
  klucz: string
  rodzaj: 'faktura' | 'korekta'
  program: 'wfirma' | 'ksef'
  /** Numer z programu do faktur (wFirma) albo z naszej serii (KSeF); null = jeszcze bez numeru. */
  numer: string | null
  /** Nasz identyfikator dokumentu (pod numerem z programu). */
  nasz: string
  orderId: string
  zamowienie: string
  nabywca: 'firma' | 'osoba prywatna'
  bruttoGr: number | null
  data: Date
  stan: StanDokumentu
  stanTekst: string
  ton: Ton
  ksefNumer: string | null
  blad: string | null
  /** PDF: z programu (wFirma, `docId`) albo z naszego generatora (`draftId`); null = brak pliku. */
  pdf: { wfirmaDocId: string } | { draftId: string } | null
  /** „Ponów”: tor ponowienia; null = nic do ponowienia. */
  ponow: 'wfirma' | 'ksef' | 'korekta-wfirma' | null
  /** Faktura: można zgłosić korektę (zwrot zamówienia); korekta: zwrot, z którego powstała. */
  returnId: string | null
  /** Korekta: numer faktury korygowanej. */
  korygowana: string | null
}

export interface FiltryFaktur {
  zakladka: ZakladkaFaktur
  seria?: string
  numer?: string
  /** 1–12 */
  miesiac?: number
  rok?: number
  /** Zamówienia z wyszukiwania po e-mailu albo telefonie (null = bez filtra). */
  zamowieniaNabywcy?: string[] | null
  tylkoBledy?: boolean
  limit?: number
}

const TON: Record<StanDokumentu, Ton> = { WYSTAWIONA: 'sukces', W_KOLEJCE: 'info', BLAD: 'blad', SZKIC: 'neutralny', POZA_KSEF: 'neutralny' }

/**
 * Skrót komunikatu do kolumny „Stan” (przegląd, ekran): najwyżej `max` znaków, cięcie na granicy słowa z „…”,
 * nigdy w pół słowa; `caly` = pełny tekst do rozwinięcia, gdy skrót coś uciął (null = mieści się w całości).
 */
export function skrotKomunikatu(tekst: string, max = 160): { skrot: string; caly: string | null } {
  const t = tekst.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return { skrot: t, caly: null }
  let ciecie = t.slice(0, max - 1)
  // ostatnia spacja, jeśli nie zjada więcej niż połowy; inaczej (jedno długie słowo, np. numer) twarde cięcie
  const spacja = ciecie.lastIndexOf(' ')
  if (spacja >= max / 2) ciecie = ciecie.slice(0, spacja)
  return { skrot: `${ciecie.replace(/[\s,;:(–-]+$/u, '')}…`, caly: t }
}

/** Stan wiersza KSeF słowem (czysta funkcja). */
export function stanKsef(status: string, ksefNumer: string | null): { stan: StanDokumentu; tekst: string } {
  const s = status as StatusKsef
  // numer KSeF osobną linią na liście (długi ciąg bez spacji nie mieści się w odznace na 390 px)
  if (s === 'PRZYJETA') return { stan: 'WYSTAWIONA', tekst: ksefNumer ? 'Wysłana do KSeF' : 'Przyjęta w KSeF' }
  if (s === 'WYSYLANA' || s === 'WYSLANA') return { stan: 'W_KOLEJCE', tekst: STATUS_KSEF_LABEL[s] }
  if (s === 'ODRZUCONA' || s === 'BLAD_WYSYLKI' || s === 'BLAD_WALIDACJI') return { stan: 'BLAD', tekst: STATUS_KSEF_LABEL[s] }
  if (s === 'POZA_KSEF') return { stan: 'POZA_KSEF', tekst: 'Poza KSeF (osoba prywatna)' }
  return { stan: 'SZKIC', tekst: 'Szkic: czeka na wysyłkę do KSeF' }
}

/** Stan próby wFirmy słowem (czysta funkcja). */
export function stanWfirmy(state: string): { stan: StanDokumentu; tekst: string } {
  if (state === 'ISSUED') return { stan: 'WYSTAWIONA', tekst: 'Wystawiona' }
  if (state === 'SENDING' || state === 'UNKNOWN') return { stan: 'W_KOLEJCE', tekst: state === 'SENDING' ? 'W kolejce' : 'W kolejce: sprawdzamy w programie, czy powstała' }
  return { stan: 'BLAD', tekst: 'Błąd wystawienia' }
}

function zakresDat(f: FiltryFaktur): { gte: Date; lt: Date } | null {
  if (!f.rok) return null
  if (f.miesiac) {
    const mm = String(f.miesiac).padStart(2, '0')
    const nast = f.miesiac === 12 ? `${f.rok + 1}-01-01` : `${f.rok}-${String(f.miesiac + 1).padStart(2, '0')}-01`
    return { gte: fromWarsaw(`${f.rok}-${mm}-01`, 0), lt: fromWarsaw(nast, 0) }
  }
  return { gte: fromWarsaw(`${f.rok}-01-01`, 0), lt: fromWarsaw(`${f.rok + 1}-01-01`, 0) }
}

const pasuje = (w: WierszFaktury, f: FiltryFaktur) => {
  const n = (w.numer ?? '').toLowerCase()
  if (f.seria && !n.startsWith(f.seria.trim().toLowerCase())) return false
  if (f.numer && !n.includes(f.numer.trim().toLowerCase()) && !w.zamowienie.toLowerCase().includes(f.numer.trim().toLowerCase()) && !(w.ksefNumer ?? '').toLowerCase().includes(f.numer.trim().toLowerCase())) return false
  if (f.tylkoBledy && w.stan !== 'BLAD') return false
  return true
}

/** Lista dokumentów zakładki, najnowsze pierwsze. Bez danych osobowych (patrz nagłówek). */
export async function listaFaktur(db: PrismaClient, f: FiltryFaktur): Promise<{ wiersze: WierszFaktury[]; wiecej: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500)
  const daty = zakresDat(f)
  const zam = f.zamowieniaNabywcy ?? null
  if (zam && !zam.length) return { wiersze: [], wiecej: false }
  const gdzieZam = zam ? { orderId: { in: zam } } : {}
  const POBIERZ = 1000
  const wiersze: WierszFaktury[] = []
  const zamowienia = new Map<string, { numer: string; firma: boolean; brutto: number }>()
  const doZamowien = new Set<string>()

  if (f.zakladka === 'faktury') {
    const proby = await db.invoiceAttempt.findMany({ where: { ...gdzieZam, ...(daty ? { createdAt: daty } : {}) }, orderBy: [{ createdAt: 'desc' }], take: POBIERZ })
    // ostatnia próba paczki (stare nieudane po ponowieniu nie dublują wiersza)
    const ostatnie = new Map<string, (typeof proby)[number]>()
    for (const p of proby) {
      const k = `${p.orderId}|${p.packageNo}`
      const byl = ostatnie.get(k)
      if (!byl || p.attemptNo > byl.attemptNo) ostatnie.set(k, p)
    }
    for (const p of ostatnie.values()) {
      doZamowien.add(p.orderId)
      const s = stanWfirmy(p.state)
      wiersze.push({
        klucz: `w:${p.id}`,
        rodzaj: 'faktura',
        program: 'wfirma',
        numer: p.number,
        nasz: p.idExternal,
        orderId: p.orderId,
        zamowienie: '',
        nabywca: 'osoba prywatna',
        bruttoGr: null,
        data: p.createdAt,
        stan: s.stan,
        stanTekst: s.tekst,
        ton: TON[s.stan],
        ksefNumer: null,
        blad: p.state === 'FAILED' ? p.lastError : null,
        pdf: p.state === 'ISSUED' && p.wfirmaDocId ? { wfirmaDocId: p.wfirmaDocId } : null,
        ponow: p.state === 'FAILED' ? 'wfirma' : null,
        returnId: null,
        korygowana: null,
      })
    }
  } else {
    const zwroty = await db.return.findMany({ where: { ...gdzieZam, invoiceDocId: { not: null }, OR: [{ correctionState: { not: null } }, { correctionDocId: { not: null } }], ...(daty ? { createdAt: daty } : {}) }, orderBy: { createdAt: 'desc' }, take: POBIERZ })
    for (const r of zwroty) {
      doZamowien.add(r.orderId)
      const s = r.correctionDocId ? stanWfirmy('ISSUED') : stanWfirmy(r.correctionState ?? 'FAILED')
      wiersze.push({
        klucz: `z:${r.id}`,
        rodzaj: 'korekta',
        program: 'wfirma',
        numer: r.correctionDocId,
        nasz: `zwrot/${r.id}`,
        orderId: r.orderId,
        zamowienie: '',
        nabywca: 'osoba prywatna',
        bruttoGr: null,
        data: r.updatedAt,
        stan: s.stan,
        stanTekst: s.tekst,
        ton: TON[s.stan],
        ksefNumer: null,
        blad: r.correctionState === 'FAILED' ? r.lastError : null,
        pdf: null,
        ponow: r.correctionState === 'FAILED' ? 'korekta-wfirma' : null,
        returnId: r.id,
        korygowana: r.invoiceDocId,
      })
    }
  }

  const ksef = await db.ksefInvoiceDraft.findMany({ where: { ...gdzieZam, rodzaj: f.zakladka === 'faktury' ? 'VAT' : 'KOR', ...(daty ? { createdAt: daty } : {}) }, orderBy: { createdAt: 'desc' }, take: POBIERZ })
  const korygowane = new Map((await db.ksefInvoiceDraft.findMany({ where: { id: { in: ksef.flatMap((k) => (k.korygowanaId ? [k.korygowanaId] : [])) } }, select: { id: true, numer: true } })).map((k) => [k.id, k.numer]))
  for (const k of ksef) {
    doZamowien.add(k.orderId)
    const s = stanKsef(k.status, k.ksefNumer)
    wiersze.push({
      klucz: `k:${k.id}`,
      rodzaj: k.rodzaj === 'KOR' ? 'korekta' : 'faktura',
      program: 'ksef',
      numer: k.numer,
      nasz: k.id,
      orderId: k.orderId,
      zamowienie: '',
      nabywca: 'osoba prywatna',
      bruttoGr: k.bruttoGr,
      data: k.createdAt,
      stan: s.stan,
      stanTekst: s.tekst,
      ton: TON[s.stan],
      ksefNumer: k.ksefNumer,
      // WYSLANA z komunikatem = stan do sprawdzenia po nieudanym odczycie: pokazujemy go, bez tonu błędu;
      // PRZYJETA z komunikatem = dubel albo numer KSeF/UPO do sprawdzenia ręcznie
      blad: s.stan === 'BLAD' ? (k.lastError ?? s.tekst) : k.status === 'WYSLANA' || k.status === 'PRZYJETA' ? k.lastError : null,
      // PDF tylko dokumentu przyjętego w KSeF: wizualizacja niewysłanej faktury mogłaby trafić do klienta jako faktura
      pdf: k.status === 'PRZYJETA' && k.numer && k.dataWystawienia ? { draftId: k.id } : null,
      ponow: k.status === 'ODRZUCONA' || k.status === 'BLAD_WYSYLKI' || k.status === 'ZLOZONA' || k.status === 'ODLOZONA' || k.status === 'WYSLANA' ? 'ksef' : null,
      returnId: k.returnId || null,
      korygowana: k.korygowanaId ? (korygowane.get(k.korygowanaId) ?? null) : null,
    })
  }

  for (const o of await db.order.findMany({ where: { id: { in: [...doZamowien] } }, select: { id: true, externalId: true, channelNumber: true, wantInvoiceNip: true, totalGross: true } }))
    zamowienia.set(o.id, { numer: o.channelNumber ?? o.externalId, firma: o.wantInvoiceNip, brutto: Math.round(Number(o.totalGross) * 100) })
  for (const w of wiersze) {
    const z = zamowienia.get(w.orderId)
    w.zamowienie = z?.numer ?? w.orderId
    w.nabywca = z?.firma ? 'firma' : 'osoba prywatna'
    if (w.bruttoGr === null && w.rodzaj === 'faktura' && z) w.bruttoGr = z.brutto
  }
  const wynik = wiersze.filter((w) => pasuje(w, f)).sort((a, b) => b.data.getTime() - a.data.getTime())
  return { wiersze: wynik.slice(0, limit), wiecej: wynik.length > limit }
}

/** Miesiąc i rok „teraz” w Warszawie (domyślny filtr listy). */
export function biezacyOkres(now = new Date()): { rok: number; miesiac: number } {
  const [r, m] = toWarsaw(now).day.split('-')
  return { rok: Number(r), miesiac: Number(m) }
}
