// (R13 z przeglądu TwojOMS): ekran „Integracje” — wszystkie połączenia firmy na jednej liście w grupach
// Sprzedaż / Wysyłka / Dokumenty sprzedaży / Poczta / Agenci AI, przy każdej pozycji stan i jeden przycisk do obecnej
// podstrony. Tylko odczyt z bazy (konta, ostatnie odczyty, testy połączeń zapisane wcześniej), bez wywołań zewnętrznych
// przy wejściu na ekran. Nazwy BaseLinkera i wFirmy tylko u firmy, która je ma (firma demo widzi same „Niepodłączony”).
// Budowa listy (`pozycjeIntegracji`) jest czysta (test jednostkowy), odczyt (`daneIntegracji`) osobno.
import type { Channel, PrismaClient } from '@prisma/client'
import type { AdapterRegistry } from '@/lib/adaptery/rejestr'
import { dostawcaAiFirmy, zrodloKluczaAi } from '@/lib/ai'
import { listApiKeys } from '@/lib/api/zarzadzanie'
import { MCP_SCOPES } from '@/lib/api/zakresy'
import { organizationIdOf } from '@/lib/db'
import { programFaktur, parseUstawieniaDokumentow } from '@/lib/dokumenty/ustawienia'
import { firmaMaBlWPanelu, firmaMaWfirme } from '@/lib/kanaly/firma'
import { listaKont, type KontoWiersz } from '@/lib/kanaly/dane'
import { platformy } from '@/lib/kanaly/platformy'
import { trybKonta } from '@/lib/kanaly/tryb'
import { ETYKIETA_SRODOWISKA, parseKonfiguracjaKsef } from '@/lib/ksef/konfiguracja'
import { KSEF_TOKEN } from '@/lib/ksef/wysylka'
import { appModeOf } from '@/lib/organizacje'
import { kontaPrzewoznikow, zrodloKluczyPanelu, type KontoPrzewoznika } from '@/lib/wysylka/konta'
import { when } from './format'
import { SLOWNIK } from './slownik'
import type { Ton } from './statusy'

/** Klucz pliku logo (`app/(panel)/ustawienia/integracje/loga/<klucz>.svg`); marki bez pliku = ikona rodzaju. */
export type LogoIntegracji = 'woocommerce' | 'allegro' | 'prestashop' | 'dpd' | 'claude' | 'sklep' | 'paczka' | 'dokument' | 'koperta' | 'klucz'

export interface StanIntegracji {
  ton: Ton
  tekst: string
}

export interface PozycjaIntegracji {
  klucz: string
  nazwa: string
  logo: LogoIntegracji
  szczegol: string
  stany: StanIntegracji[]
  akcja: { etykieta: 'Zarządzaj' | 'Podłącz'; href: string }
}

export interface GrupaIntegracji {
  klucz: 'sprzedaz' | 'wysylka' | 'dokumenty' | 'poczta' | 'ai'
  tytul: string
  pozycje: PozycjaIntegracji[]
}

export interface DaneIntegracji {
  kanaly: Pick<KontoWiersz, 'kod' | 'channel' | 'channelAccountId' | 'name' | 'rodzaj' | 'active' | 'stockMode' | 'statusMode' | 'trackingMode' | 'testOk' | 'lastReadAt' | 'readError'>[]
  /** platformy z rejestru (kreator „Dodaj sklep”) */
  platformy: { klucz: string; channel: Channel; nazwa: string }[]
  maBl: boolean
  przewoznicy: Pick<KontoPrzewoznika, 'id' | 'nazwa' | 'adapterKey' | 'sekrety' | 'reguly' | 'test'>[]
  dokumenty: {
    /** `brak`, `wfirma`, `ksef` albo klucz adaptera programu */
    program: string
    nazwaProgramu: string | null
    maWfirme: boolean
    fakturyWlaczone: boolean
    ksefToken: boolean
    srodowiskoKsef: string
  }
  poczta: { wlaczona: boolean; host: string; nadawca: string; ostatniBlad: Date | null }
  ai: { model: string; zrodloKlucza: 'firma' | 'platforma' | 'env' | null; packshot: boolean }
  klucze: { agentow: number; innych: number; ostatnieUzycieAgenta: Date | null }
}

const LOGO_KANALU: Partial<Record<Channel, LogoIntegracji>> = { WOO: 'woocommerce', ALLEGRO: 'allegro', PRESTASHOP: 'prestashop' }

function logoPrzewoznika(adapterKey: string): LogoIntegracji {
  if (adapterKey.startsWith('dpd')) return 'dpd'
  if (adapterKey.includes('allegro')) return 'allegro'
  return 'paczka'
}

/** 1 reguła, 2–4 reguły, 5+ reguł (22 reguły, 12 reguł). */
function reguly(n: number): string {
  if (n === 1) return 'reguła'
  const j = n % 10
  const d = n % 100
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? 'reguły' : 'reguł'
}

/** Stan kanału: odczyt (ostatni udany, błędy) i zapis (tryb konta). */
function stanyKanalu(k: DaneIntegracji['kanaly'][number], now: Date): StanIntegracji[] {
  if (!k.active) return [{ ton: 'neutralny', tekst: 'Konto wyłączone' }]
  const out: StanIntegracji[] = []
  if (k.readError) out.push({ ton: 'blad', tekst: 'Odczyt zamówień z błędami' })
  else if (k.lastReadAt) out.push({ ton: 'sukces', tekst: `Ostatni udany odczyt: ${when(k.lastReadAt, now)}` })
  else if (k.testOk === false) out.push({ ton: 'blad', tekst: 'Test połączenia nieudany' })
  else out.push({ ton: 'neutralny', tekst: 'Jeszcze bez odczytu' })
  const tryb = trybKonta(k)
  out.push(
    tryb === 'PRACA'
      ? { ton: 'sukces', tekst: 'Zapisuje stany i statusy' }
      : tryb === 'BEZ_STANOW'
        ? { ton: 'sukces', tekst: 'Zapisuje statusy i numery nadania, bez stanów' }
        : tryb === 'CIEN'
          ? { ton: 'neutralny', tekst: SLOWNIK.zapisWylaczony }
          : { ton: 'ostrzezenie', tekst: 'Zapis częściowo włączony' },
  )
  return out
}

function przewoznik(k: DaneIntegracji['przewoznicy'][number], now: Date): PozycjaIntegracji {
  const wymagane = k.sekrety.filter((s) => s.wymagany)
  const podlaczony = k.sekrety.some((s) => s.ustawiony) && wymagane.every((s) => s.ustawiony)
  const stany: StanIntegracji[] = []
  if (!podlaczony) stany.push({ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony })
  else {
    const t = k.test ? new Date(k.test.at) : null
    if (k.test && t && !Number.isNaN(t.getTime())) stany.push(k.test.ok ? { ton: 'sukces', tekst: `Połączenie działa (test ${when(t, now)})` } : { ton: 'blad', tekst: 'Test połączenia nieudany' })
    else stany.push({ ton: 'neutralny', tekst: 'Klucze zapisane, bez testu' })
    const zWylacznikiem = k.reguly.filter((r) => r.nadawanie !== null)
    if (zWylacznikiem.some((r) => r.nadawanie)) stany.push({ ton: 'sukces', tekst: 'Nadawanie włączone' })
    else if (zWylacznikiem.length) stany.push({ ton: 'neutralny', tekst: SLOWNIK.zapisWylaczony })
  }
  const n = k.reguly.length
  return {
    klucz: `przewoznik:${k.id}`,
    nazwa: k.nazwa,
    logo: logoPrzewoznika(k.adapterKey),
    szczegol: n === 0 ? 'Bez reguł wysyłki' : `${n} ${reguly(n)} wysyłki`,
    stany,
    akcja: { etykieta: podlaczony ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/przewoznicy/konta' },
  }
}

const ZRODLO_AI: Record<NonNullable<DaneIntegracji['ai']['zrodloKlucza']>, string> = {
  firma: 'Własny klucz firmy',
  platforma: 'Klucz Kompletora (z salda)',
  env: 'Klucz z konfiguracji serwera',
}

export function pozycjeIntegracji(d: DaneIntegracji, now = new Date()): GrupaIntegracji[] {
  // Sprzedaż: podłączone konta, potem platformy bez konta („Podłącz” otwiera kreator z wybraną platformą)
  const sprzedaz: PozycjaIntegracji[] = d.kanaly.map((k) => ({
    klucz: `kanal:${k.kod}`,
    nazwa: k.name,
    logo: LOGO_KANALU[k.channel] ?? 'sklep',
    // rodzaj bez nazwy platformy (np. EasyTools) przychodzi jako klucz adaptera: wtedy samo konto
    szczegol: /^[a-z0-9]+(\.[a-z0-9]+)+$/.test(k.rodzaj) ? `Konto ${k.channelAccountId}` : `${k.rodzaj}, konto ${k.channelAccountId}`,
    stany: stanyKanalu(k, now),
    akcja: { etykieta: 'Zarządzaj', href: `/ustawienia/kanaly/${encodeURIComponent(k.kod)}` },
  }))
  const zKontem = new Set(d.kanaly.map((k) => k.channel))
  for (const p of d.platformy) {
    if (zKontem.has(p.channel)) continue
    sprzedaz.push({
      klucz: `platforma:${p.klucz}`,
      nazwa: p.nazwa,
      logo: LOGO_KANALU[p.channel] ?? 'sklep',
      szczegol: 'Brak konta w Kompletorze',
      stany: [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }],
      akcja: { etykieta: 'Podłącz', href: `/ustawienia/kanaly/nowy?platforma=${encodeURIComponent(p.klucz)}` },
    })
  }
  if (d.maBl) {
    sprzedaz.push({ klucz: 'bl', nazwa: 'BaseLinker', logo: 'sklep', szczegol: SLOWNIK.przejscieZBl, stany: [{ ton: 'info', tekst: 'Podłączony' }], akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/przeprowadzka' } })
  }

  // Dokumenty sprzedaży: program firmy; wFirma tylko u firmy z wFirmą, KSeF zawsze (droga bez programu księgowego)
  const dk = d.dokumenty
  const dokumenty: PozycjaIntegracji[] = []
  const wystawianie: StanIntegracji = dk.fakturyWlaczone ? { ton: 'sukces', tekst: 'Wystawianie włączone' } : { ton: 'neutralny', tekst: SLOWNIK.zapisWylaczony }
  const wbudowany = dk.program === 'brak' || dk.program === 'wfirma' || dk.program === 'ksef'
  if (!wbudowany) {
    dokumenty.push({ klucz: `program:${dk.program}`, nazwa: dk.nazwaProgramu ?? dk.program, logo: 'dokument', szczegol: 'Program do faktur', stany: [{ ton: 'sukces', tekst: 'Podłączony' }, wystawianie], akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/dokumenty' } })
  }
  if (dk.program === 'brak') {
    dokumenty.push({ klucz: 'program:brak', nazwa: 'Bez programu do faktur', logo: 'dokument', szczegol: 'Dokumenty sprzedaży wystawiasz poza Kompletorem', stany: [{ ton: 'neutralny', tekst: 'Bez programu' }], akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/dokumenty' } })
  }
  if (dk.maWfirme || dk.program === 'wfirma') {
    const wybrany = dk.program === 'wfirma'
    dokumenty.push({
      klucz: 'program:wfirma',
      nazwa: 'wFirma',
      logo: 'dokument',
      szczegol: wybrany ? 'Program do faktur' : 'Magazyn firmy (faktury innym programem)',
      stany: wybrany ? [{ ton: 'sukces', tekst: 'Podłączony' }, wystawianie] : [{ ton: 'sukces', tekst: 'Podłączony' }],
      akcja: { etykieta: 'Zarządzaj', href: '/ustawienia/dokumenty' },
    })
  }
  const ksef = dk.program === 'ksef'
  dokumenty.push({
    klucz: 'program:ksef',
    nazwa: 'KSeF',
    logo: 'dokument',
    szczegol: ksef ? `Faktury bezpośrednio do KSeF, środowisko ${dk.srodowiskoKsef}` : 'Faktury bezpośrednio do KSeF, bez programu księgowego',
    stany: !ksef ? [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }] : dk.ksefToken ? [{ ton: 'sukces', tekst: 'Token zapisany' }, wystawianie] : [{ ton: 'ostrzezenie', tekst: 'Brak tokenu KSeF' }],
    akcja: { etykieta: ksef ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/dokumenty' },
  })

  const pc = d.poczta
  const poczta: PozycjaIntegracji = {
    klucz: 'poczta',
    nazwa: 'Serwer poczty firmy',
    logo: 'koperta',
    szczegol: pc.host ? `${pc.host}${pc.nadawca ? `, nadawca ${pc.nadawca}` : ''}` : 'Maile do klientów z adresu firmy',
    stany: !pc.host
      ? [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }]
      : !pc.wlaczona
        ? [{ ton: 'neutralny', tekst: 'Wysyłka wyłączona' }]
        : pc.ostatniBlad
          ? [{ ton: 'blad', tekst: `Ostatni błąd wysyłki: ${when(pc.ostatniBlad, now)}` }]
          : [{ ton: 'sukces', tekst: 'Wysyła maile' }],
    akcja: { etykieta: pc.host ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/poczta' },
  }

  const ai: PozycjaIntegracji[] = [
    {
      klucz: 'ai:dostawca',
      nazwa: 'Dostawca AI (Claude)',
      logo: 'claude',
      szczegol: `Opisy produktów${d.ai.packshot ? ' i packshoty' : ''}, model ${d.ai.model}`,
      stany: d.ai.zrodloKlucza ? [{ ton: 'sukces', tekst: ZRODLO_AI[d.ai.zrodloKlucza] }] : [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }],
      akcja: { etykieta: d.ai.zrodloKlucza ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/agenci-ai' },
    },
    {
      klucz: 'ai:asystent',
      nazwa: 'Asystent AI (Claude Code, Cursor i inne)',
      logo: 'klucz',
      szczegol: d.klucze.agentow ? `Kluczy agentów: ${d.klucze.agentow}, tylko odczyt` : 'Dostęp agenta AI do danych firmy, tylko odczyt',
      stany: d.klucze.agentow
        ? [{ ton: 'sukces', tekst: d.klucze.ostatnieUzycieAgenta ? `Ostatnie użycie: ${when(d.klucze.ostatnieUzycieAgenta, now)}` : 'Jeszcze nieużywany' }]
        : [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }],
      akcja: { etykieta: d.klucze.agentow ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/agenci-ai' },
    },
    {
      klucz: 'api',
      nazwa: 'Dostęp przez API',
      logo: 'klucz',
      szczegol: d.klucze.innych ? `Aktywnych kluczy dla innych systemów: ${d.klucze.innych}` : 'Stany i zamówienia dla innych systemów (np. chatbot, sklep hurtowy)',
      stany: d.klucze.innych ? [{ ton: 'sukces', tekst: 'Klucze aktywne' }] : [{ ton: 'neutralny', tekst: SLOWNIK.niepodlaczony }],
      akcja: { etykieta: d.klucze.innych ? 'Zarządzaj' : 'Podłącz', href: '/ustawienia/klucze-api' },
    },
  ]

  return [
    { klucz: 'sprzedaz', tytul: 'Sprzedaż', pozycje: sprzedaz },
    { klucz: 'wysylka', tytul: 'Wysyłka', pozycje: d.przewoznicy.map((k) => przewoznik(k, now)) },
    { klucz: 'dokumenty', tytul: 'Dokumenty sprzedaży', pozycje: dokumenty },
    { klucz: 'poczta', tytul: 'Poczta', pozycje: [poczta] },
    { klucz: 'ai', tytul: 'Agenci AI', pozycje: ai },
  ]
}

/** Odczyt stanu wszystkich integracji firmy z bazy (klient firmy, RLS). Bez wywołań zewnętrznych. */
export async function daneIntegracji(db: PrismaClient, registry: AdapterRegistry, env: Record<string, string | undefined> = process.env): Promise<DaneIntegracji> {
  organizationIdOf(db)
  const src = { env, envFallback: appModeOf(env) === 'self-host' }
  const [kanaly, maBl, przewoznicy, maWfirme, org, ksefToken, mail, aiFirmy, klucze] = await Promise.all([
    listaKont(db, registry),
    firmaMaBlWPanelu(db, env),
    kontaPrzewoznikow(db, registry, zrodloKluczyPanelu(env)),
    firmaMaWfirme(db),
    db.organization.findFirst({ select: { settings: true } }),
    db.integrationSecret.count({ where: { name: KSEF_TOKEN, channel: null, channelAccountId: null } }),
    db.mailSettings.findFirst({ select: { enabled: true, host: true, fromEmail: true, lastErrorAt: true } }),
    dostawcaAiFirmy(db),
    listApiKeys(db),
  ])
  const settings = org?.settings ?? null
  const program = programFaktur(settings, { maWfirme })
  const aktywne = klucze.filter((k) => !k.revokedAt)
  const agenci = aktywne.filter((k) => k.scopes.some((s) => (MCP_SCOPES as readonly string[]).includes(s)))
  const ostatnie = agenci.map((k) => k.lastUsedAt).filter((t): t is Date => !!t).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  return {
    kanaly: kanaly.filter((k) => k.channel !== 'RECZNE'),
    platformy: platformy(registry).map((p) => ({ klucz: p.klucz, channel: p.channel, nazwa: p.nazwa })),
    maBl,
    przewoznicy,
    dokumenty: {
      program,
      nazwaProgramu: registry.get(program)?.manifest.displayName ?? null,
      maWfirme,
      fakturyWlaczone: parseUstawieniaDokumentow(settings, { maWfirme }).fakturyWlaczone,
      ksefToken: ksefToken > 0,
      srodowiskoKsef: ETYKIETA_SRODOWISKA[parseKonfiguracjaKsef(settings).srodowisko],
    },
    poczta: { wlaczona: mail?.enabled ?? false, host: mail?.host ?? '', nadawca: mail?.fromEmail ?? '', ostatniBlad: mail?.lastErrorAt ?? null },
    ai: { model: aiFirmy.model, zrodloKlucza: await zrodloKluczaAi(db, aiFirmy.accountId, src), packshot: aiFirmy.packshot },
    klucze: { agentow: agenci.length, innych: aktywne.length - agenci.length, ostatnieUzycieAgenta: ostatnie },
  }
}
