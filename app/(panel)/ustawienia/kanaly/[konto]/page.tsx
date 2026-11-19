// Ustawienia → Kanały sprzedaży → konto (przebudowa na komponentach app/ui): stan konta jako jedna
// odznaka (czyta / zapisuje / błąd), ostatni odczyt i zapis, tryb „Tylko podgląd” / „Aktywny” z wyjaśnieniem i
// przełącznikiem (warunki z lib/kanaly/tryb.ts, potwierdzenie), kroki nowego konta (Klucze → Sprawdź → Oferty →
// Przypisz → Włącz), „Połącz z Allegro” bez terminala, „Sprawdź połączenie”, „Pobierz oferty”, lista „Do przypisania”
// (bez danych klienta), jeden zapis ustawień i kluczy (pola rzadkie w „Zaawansowane”). Sekcja „Zapis do
// sklepu” (zapis.tsx). „Łączenie ofert z produktami” pod „Do przypisania” (laczenie.tsx).
// WooCommerce — „Połączenie ze sklepem” (woo.tsx, wc-auth) i „Pola zamówienia” (pola-zamowienia.tsx, podpowiedź pól
// NIP / punktu / faktury z testu połączenia). Tylko z uprawnieniem `ustawienia`.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { appModeOf } from '@/lib/organizacje'
import { stanAllegro, type StanAllegro } from '@/lib/kanaly/allegro-autoryzacja'
import { kontoEkran, szukajProduktow } from '@/lib/kanaly/dane'
import { firmaMaWfirme, firmaPrzechodziZBlWPanelu } from '@/lib/kanaly/firma'
import { kodKonta, parseKodKonta } from '@/lib/kanaly/konta'
import { etykietaPola, nazwaPlatformy, POLA_POZA_FORMULARZEM } from '@/lib/kanaly/platformy'
import { blokadaInstancji, mozna, prowadziZamowienia, trybKonta, warunkiPracy, warunkiZapisu } from '@/lib/kanaly/tryb'
import { type PowrotWoo, powrotWoo, stanWoo, type StanWoo } from '@/lib/kanaly/woo-autoryzacja'
import { type EkranZapisu, ekranZapisu } from '@/lib/kanaly/zapis-host'
import { int, when } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { Baner, Karta, ListaOpisowa, NaglowekStrony, Odznaka, PasekZapisu, PoleLiczbowe, PoleTekstowe, Przycisk, PrzyciskPotwierdz, TrybKanalu, Zaawansowane } from '@/app/ui'
import { pobierzOfertyKonta, przypisz, sprawdzPolaczenie, ustawAktywne, utworzProdukt, wlaczPonownie, zapiszKonto, zmienTryb } from '../akcje'
import { kluczKanalu, stanWylaczenia } from '@/lib/integracje/zdrowie'
import { WylaczonePoBledach } from '@/app/(panel)/_komponenty/wylaczone-po-bledach'
import { Odswiezanie } from '../odswiezanie'
import { PoleSekretuWejscie, PoleUstawieniaWejscie } from '../pola'
import { ToastZAdresu } from '../toast-z-adresu'
import { PolaczenieAllegro } from './allegro'
import { Warunki } from './warunki'
import { ZapisDoSklepu } from './zapis'
import { LaczenieOfert } from './laczenie'
import { PolaczenieWoo } from './woo'
import { PolaZamowienia } from './pola-zamowienia'
import '../kanaly.css'

export const metadata = { title: 'Konto kanału' }

const registry = defaultRegistry()
type Props = { params: Promise<{ konto: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// „Połączono” tylko po faktycznym zapisie kluczy z tego łączenia.
// stała modułu; „odświeży się sam” tylko przy trwającym łączeniu (`czeka`), bez niego (`nie-trwa`) inna rada.
const POWROT_WOO: Record<PowrotWoo, { sukces?: string; blad?: string }> = {
  polaczono: { sukces: 'Połączono ze sklepem. Klucze zapisane (zaszyfrowane), sprawdzam połączenie.' },
  czeka: { sukces: 'Sklep zatwierdził dostęp. Klucze jeszcze nie dotarły: ekran odświeży się sam.' },
  'nie-trwa': { blad: 'Nie ma trwającego łączenia ze sklepem (anulowane albo nierozpoczęte). Kliknij „Połącz z WooCommerce”.' },
  wygasl: { blad: 'Link do sklepu wygasł, zanim sklep przysłał klucze. Nic nie zapisano: kliknij „Połącz z WooCommerce” jeszcze raz.' },
  'zle-uprawnienia': { blad: 'Sklep przysłał klucz z innymi uprawnieniami, niż prosiliśmy, więc go nie zapisaliśmy. Kliknij „Połącz z WooCommerce” jeszcze raz.' },
  'zly-ksztalt': { blad: 'Sklep przysłał klucz w nieznanym formacie, więc go nie zapisaliśmy. Kliknij „Połącz z WooCommerce” jeszcze raz; jeśli się powtórzy, wklej klucze ręcznie (WooCommerce → Ustawienia → Zaawansowane → REST API).' },
}

const SAVED: Record<string, string> = {
  dodano: 'Konto zapisane. Teraz „Sprawdź połączenie”.',
  'dodano-test': 'Konto zapisane. Sprawdzam połączenie, wynik pojawi się za chwilę.',
  'dodano-allegro': 'Konto zapisane. Teraz otwórz Allegro i zatwierdź dostęp.',
  'dodano-allegro-blad': 'Konto zapisane. Nie udało się rozpocząć połączenia: sprawdź Client ID i Client Secret i kliknij „Połącz z Allegro”.',
  // „Anuluj” tuż po połączeniu (nic już nie trwało) — bez „przed anulowaniem”
  'allegro-zdazylo': 'Konto jest już połączone z Allegro.',
  'zapis-wlaczony': 'Zapis do sklepu włączony. Wysyłka rusza w trybie pracy.',
  //
  'zapis-wlaczony-bez-pracy': 'Zapis do sklepu włączony, ale ta instancja nie ma trybu pracy dla firm przechodzących z BaseLinkera: nic nie wyjdzie, dopóki administrator serwera go nie włączy.',
  'woo-anulowane': 'Łączenie ze sklepem przerwane. Zapisane wcześniej klucze działają dalej.',
  'pole-meta': 'Pole zamówienia ustawione. Nowe dane zamówień czytamy już z niego.',
  'pole-meta-bez-zmian': 'To pole było już ustawione.',
  'zapis-wylaczony': 'Zapis do sklepu wyłączony: Kompletor niczego do sklepu nie wysyła.',
  'wystawianie-wlaczone': 'Wystawianie ofert włączone: przycisk „Wystaw” na karcie produktu (zakładka „Publikacja”) wyśle ofertę na to konto.',
  'wystawianie-wylaczone': 'Wystawianie ofert wyłączone: z karty produktu zobaczysz tylko podgląd oferty.',
  ustawienia: 'Ustawienia zapisane.',
  'konto-klucze': 'Ustawienia i klucze zapisane (klucze zaszyfrowane).',
  klucze: 'Klucze zapisane (zaszyfrowane).',
  wlaczono: 'Konto włączone.',
  wylaczono: 'Konto wyłączone. Dane, oferty i klucze zostają.',
  test: 'Test połączenia zlecony.',
  oferty: 'Pobranie ofert zlecone.',
  przypisano: 'Oferta przypisana.',
  produkt: 'Produkt utworzony i oferta przypisana.',
  statusy: 'Statusy w sklepie zapisane.',
  wypchnij: 'Zlecone: stany ofert i zapisy z błędem pójdą przy najbliższym przebiegu (do minuty).',
  wlaczanie: 'Sprawdzam połączenie. Gdy test przejdzie, konto wróci do pracy samo (wynik za chwilę).',
  'wersja-zapisu': 'Konto przełączone na wersję z zapisem. Zapis zostaje wyłączony, dopóki nie włączysz go przełącznikiem „Zapis do sklepu” niżej.',
  'wersja-odczytu': 'Konto przełączone na wersję tylko do odczytu. Kompletor dalej czyta zamówienia i oferty, a do sklepu niczego nie wysyła.',
  'stany-ponownie': 'Zlecone: stany wszystkich ofert pójdą do sklepu od nowa przy najbliższym przebiegu (do minuty), także te bez zmian.',
  'pelny-zapis': 'Zapisano: co ile godzin stany idą do sklepu mimo braku zmian.',
  'allegro-link': 'Otwórz Allegro i zatwierdź dostęp. Ekran odświeży się sam.',
  'allegro-anulowane': 'Połączenie z Allegro przerwane. Dotychczasowe (jeśli było) działa dalej.',
  'tryb-praca': 'Konto jest aktywne: Kompletor prowadzi zamówienia z tego konta.',
  'tryb-podglad': 'Konto wróciło do trybu „Tylko podgląd”: niczego w sklepie nie zmieniamy.',
  'tryb-bez-stanow': 'Konto pracuje bez stanów: Kompletor prowadzi zamówienia, stany ofert wysyła dalej dotychczasowy system.',
}

const STATE_LABEL: Record<string, string> = {
  BEZ_SKU: 'bez SKU',
  WIELOZNACZNE: 'niepewne',
  BEZ_PRODUKTU: 'brak produktu',
  BLAD: 'błąd zapisu',
  Z_ZAMOWIENIA: 'z zamówienia',
}

type Ton = 'sukces' | 'ostrzezenie' | 'blad' | 'info' | 'neutralny'

/** Stan konta jedną odznaką: najpierw problemy, potem to, co konto faktycznie robi. */
function stanKonta(
  k: { active: boolean; testOk: boolean | null; readError: string | null; lastReadAt: Date | null; stockMode: string; statusMode: string; trackingMode: string },
  zapis: EkranZapisu | null,
  allegro: StanAllegro | null,
): { ton: Ton; tekst: string; opis: string } {
  if (!k.active) return { ton: 'neutralny', tekst: 'Wyłączone', opis: 'Konto nie jest czytane.' }
  if (allegro && (!allegro.polaczone || allegro.odrzucone)) return { ton: 'blad', tekst: 'Błąd', opis: 'Konto nie jest połączone z Allegro.' }
  if (k.testOk === false || k.readError) return { ton: 'blad', tekst: 'Błąd', opis: k.readError ?? 'Ostatni test połączenia nie przeszedł.' }
  const zapisuje = !!zapis && Object.values(zapis.powody).some((p) => p === null)
  if (zapisuje) return { ton: 'sukces', tekst: 'Zapisuje', opis: 'Czyta zamówienia i wysyła zmiany do sklepu.' }
  if (k.testOk === true || k.lastReadAt) return { ton: 'info', tekst: 'Czyta', opis: 'Czyta zamówienia, do sklepu niczego nie wysyła.' }
  return { ton: 'ostrzezenie', tekst: 'Nie sprawdzone', opis: 'Połączenia jeszcze nie sprawdzano.' }
}

function ostatniZapis(z: EkranZapisu | null): Date | null {
  if (!z) return null
  const daty = [z.stany.ostatniZapis, ...z.zapisy.ostatnie.filter((w) => w.stan === 'wysłane').map((w) => w.kiedy)].filter((d): d is Date => !!d)
  return daty.length ? new Date(Math.max(...daty.map((d) => d.getTime()))) : null
}

export default async function KontoKanalu({ params, searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const ref = parseKodKonta((await params).konto)
  if (!ref) notFound()
  const sp = await searchParams
  const now = new Date()
  const e = await kontoEkran(ctx.db, registry, ref, now)
  if (!e) notFound()
  const kod = kodKonta(ref)
  const q = one(sp.szukaj) ?? ''
  const src = { env: process.env, envFallback: appModeOf(process.env) === 'self-host' }
  const [found, hasWfirma, zapis, firmaZBl, allegro, woo, wylaczone] = await Promise.all([
    szukajProduktow(ctx.db, q),
    firmaMaWfirme(ctx.db),
    ekranZapisu(ctx.db, registry, ref, now),
    firmaPrzechodziZBlWPanelu(ctx.db),
    ref.channel === 'ALLEGRO' ? stanAllegro(ctx.db, ref, src, now) : Promise.resolve(null),
    ref.channel === 'WOO' ? stanWoo(ctx.db, ref, { env: process.env, registry, now }) : Promise.resolve<StanWoo | null>(null),
    stanWylaczenia(ctx.db, kluczKanalu(ref.channel, ref.channelAccountId)),
  ])
  const k = e.konto
  const st = e.ostatniPrzebieg?.stats
  // wyłączone po błędach wygrywa z resztą stanów (host nic nie woła, zadania czekają)
  const stan = wylaczone ? { ton: 'blad' as const, tekst: 'Wyłączone po błędach', opis: 'Kompletor przestał wołać to konto po serii błędów połączenia. Zadania czekają.' } : stanKonta(k, zapis, allegro)
  const tryb = trybKonta(k)
  const warunki = warunkiPracy({ active: k.active, testOk: k.testOk, offers: k.offers, manifest: e.manifest, config: e.config, firmaZBl }, process.env)
  // te same warunki dla pracy bez stanów (inne ostrzeżenia: stany zostają w dotychczasowym systemie)
  const warunkiBezStanow = warunkiPracy({ active: k.active, testOk: k.testOk, offers: k.offers, manifest: e.manifest, config: e.config, firmaZBl, bezStanow: true }, process.env)
  const kto = firmaZBl ? 'BaseLinker' : 'dotychczasowy system'
  const warunkiZ = warunkiZapisu({ active: k.active, manifest: e.manifest, config: e.config, tryb, sekrety: new Set(e.sekrety.filter((x) => !!x.savedAt).map((x) => x.field.name)), zEnv: !!e.envPrefix, blokadaInstancji: blokadaInstancji(process.env, firmaZBl) })
  // tryb konta i wyłącznik zapisu wymagają uprawnienia „Zmiana trybu kanału”
  const mozeTryb = ctx.permissions.has('kanaly.tryb')
  const bezTrybu = mozeTryb ? undefined : 'Nie masz uprawnienia do zmiany trybu kanału'
  // firma z BaseLinkerem na instancji bez trybu pracy nie domknie kroku 5, więc karta go nie pokazuje
  const trybDostepny = !blokadaInstancji(process.env, firmaZBl)
  const zapisano = one(sp.zapisano) ?? ''
  const zam = Number(one(sp.zamowien) ?? 0)
  const kluczOdczytu = e.sekrety.some((x) => x.field.name === 'WOO_CONSUMER_KEY' && !!x.savedAt)
  const kluczZapisu = e.sekrety.some((x) => x.field.name === 'WOO_WRITE_KEY' && !!x.savedAt)
  // powrót ze strony zatwierdzenia w sklepie (`?woo=powrot&success=1|0&user_id=…`); toast czyści adres
  const zWoo =
    woo && one(sp.woo) === 'powrot'
      ? one(sp.success) === '1'
        ? POWROT_WOO[powrotWoo(woo, e.sekrety.filter((x) => x.field.name === 'WOO_CONSUMER_KEY' || x.field.name === 'WOO_WRITE_KEY').map((x) => x.savedAt))]
        : { blad: 'Dostęp nie został zatwierdzony w sklepie. Nic nie zapisano. Link do sklepu jest ważny jeszcze przez chwilę: „Otwórz sklep jeszcze raz” albo „Anuluj” w sekcji „Połączenie ze sklepem”.' }
      : null
  const sukces = zWoo ? (zWoo.sukces ?? null) : SAVED[zapisano] ? `${SAVED[zapisano]}${zam > 0 ? ` Przeliczone zamówienia: ${int(zam)}.` : ''}` : null

  const kluczeGotowe = allegro ? allegro.polaczone && !allegro.odrzucone : e.sekrety.every((s) => !s.field.required || !!s.savedAt) || !!e.envPrefix
  const kroki = [
    { nazwa: allegro ? 'Połącz z Allegro' : woo ? 'Połącz ze sklepem' : 'Klucze', gotowe: kluczeGotowe, gdzie: allegro ? '#allegro' : woo ? '#woo' : '#ustawienia' },
    { nazwa: 'Sprawdź połączenie', gotowe: k.testOk === true, gdzie: '#polaczenie' },
    { nazwa: 'Pobierz oferty', gotowe: !e.canReadOffers || !!e.ostatniPrzebieg, gdzie: '#oferty' },
    { nazwa: 'Przypisz produkty', gotowe: k.offers > 0 && e.doPrzypisania.length === 0, gdzie: '#przypisz' },
    ...(trybDostepny ? [{ nazwa: 'Włącz tryb pracy', gotowe: prowadziZamowienia(tryb), gdzie: '#stan' }] : []),
  ]
  const teraz = kroki.findIndex((x) => !x.gotowe)
  const podstawowe = e.ustawienia.filter((u) => u.field.required)
  const rzadkie = e.ustawienia.filter((u) => !u.field.required && !POLA_POZA_FORMULARZEM.has(u.field.key))
  const kluczeRzadkie = e.sekrety.filter((x) => !x.field.required)

  return (
    <>
      <ToastZAdresu sukces={sukces} blad={zWoo?.blad ?? one(sp.blad)?.slice(0, 300)} zostaw={q ? { szukaj: q } : undefined} />
      <NaglowekStrony
        tytul={<span className="kn-zawijaj">{k.name}</span>}
        podtytul={nazwaPlatformy(ref.channel) ?? k.rodzaj}
        akcje={
          <Odznaka ton={stan.ton} kropka title={stan.opis}>
            {stan.tekst}
          </Odznaka>
        }
      />

      {wylaczone && (
        <WylaczonePoBledach stan={wylaczone} now={now} akcja={wlaczPonownie} pola={{ konto: kod }} />
      )}

      {teraz >= 0 && (
        <Karta tytul="Pierwsze kroki z tym kontem" opis={`Krok ${teraz + 1} z ${kroki.length}: ${kroki[teraz]!.nazwa.toLowerCase()}.`}>
          <ol className="kn-kroki">
            {kroki.map((x, i) => (
              <li key={x.nazwa} className="kn-krok" data-stan={x.gotowe ? 'zrobione' : i === teraz ? 'teraz' : 'potem'}>
                <a href={x.gdzie}>{x.nazwa}</a>
              </li>
            ))}
          </ol>
        </Karta>
      )}

      <Karta id="stan" tytul="Stan konta" opis={stan.opis}>
        <ListaOpisowa
          kolumny={2}
          pozycje={[
            { etykieta: 'Ostatni odczyt zamówień', wartosc: k.lastReadAt ? when(k.lastReadAt, now) : 'jeszcze nie było' },
            { etykieta: 'Ostatni zapis do sklepu', wartosc: (() => { const d = ostatniZapis(zapis); return d ? when(d, now) : 'jeszcze nie było' })() },
            { etykieta: 'Tryb', wartosc: <TrybKanalu tryb={tryb} aktywne={k.active} /> },
            { etykieta: 'Połączenie', wartosc: k.testOk === null ? 'nie sprawdzano' : k.testOk ? `działa (${when(k.testCheckedAt!, now)})` : 'błąd' },
          ]}
        />
        <p className="small">
          {!k.active
            ? 'Konto wyłączone: włącz je niżej, żeby Kompletor czytał zamówienia.'
            : tryb === 'PRACA'
            ? 'Aktywny: Kompletor prowadzi zamówienia z tego konta (statusy, pakowanie, wysyłka). Do sklepu wysyła zmiany tylko wtedy, gdy w sekcji „Zapis do sklepu” zapis jest włączony.'
            : tryb === 'BEZ_STANOW'
            ? `Aktywny bez stanów: Kompletor prowadzi zamówienia z tego konta (statusy, numery nadania, pakowanie, wysyłka, faktury). Stany ofert wysyła dalej ${kto}, Kompletor ich do sklepu nie wysyła.`
            : 'Tylko podgląd: Kompletor czyta zamówienia i liczy, co by zrobił, ale niczego w sklepie nie zmienia. Zamówienia prowadzisz jak dotąd.'}
          {k.active && tryb === 'MIESZANY' && ' Część rzeczy jest w trybie pracy, część w podglądzie (ustawione poza panelem). Przełącznik ustawi wszystko naraz.'}
        </p>
        {/* osobne formularze, bo na jednym ekranie bywają dwa kierunki naraz (np. „Dołącz stany” i „Wróć do podglądu”) */}
        <div className="kn-akcje">
          {tryb !== 'PRACA' && (
            <form action={zmienTryb}>
              <input type="hidden" name="konto" value={kod} />
              <input type="hidden" name="tryb" value="PRACA" />
              <PrzyciskPotwierdz
                wariant={tryb === 'BEZ_STANOW' ? undefined : 'glowny'}
                tytul={tryb === 'BEZ_STANOW' ? 'Dołączyć stany ofert?' : 'Włączyć tryb pracy dla tego konta?'}
                pytanie={
                  <>
                    {tryb === 'BEZ_STANOW' ? (
                      <p>
                        Kompletor zacznie wysyłać do sklepu stany wszystkich przypisanych ofert (gdy zapis do sklepu jest włączony). Najpierw wyłącz wysyłanie stanów dla tego konta w: {kto}. Sprawdź też oferty bez SKU i bez produktu: dostaną stan z Kompletora albo żaden.
                      </p>
                    ) : (
                      <p>Od tej chwili Kompletor prowadzi zamówienia z tego konta: statusy, pakowanie i wysyłkę, a także stany ofert. Wrócić do podglądu możesz w każdej chwili.</p>
                    )}
                    <Warunki w={warunki} />
                  </>
                }
                tak={tryb === 'BEZ_STANOW' ? 'Dołącz stany' : 'Włącz tryb pracy'}
                powodWylaczenia={bezTrybu ?? (mozna(warunki) ? undefined : 'Spełnij warunki z listy niżej')}
              >
                {tryb === 'BEZ_STANOW' ? 'Dołącz stany ofert' : 'Włącz tryb pracy'}
              </PrzyciskPotwierdz>
            </form>
          )}
          {tryb !== 'BEZ_STANOW' && (
            <form action={zmienTryb}>
              <input type="hidden" name="konto" value={kod} />
              <input type="hidden" name="tryb" value="BEZ_STANOW" />
              <PrzyciskPotwierdz
                tytul={tryb === 'PRACA' ? 'Wyłączyć wysyłanie stanów ofert?' : 'Włączyć tryb pracy bez stanów?'}
                pytanie={
                  tryb === 'PRACA' ? (
                    <p>Kompletor dalej prowadzi zamówienia i wysyła statusy i numery nadania, ale przestaje wysyłać stany ofert. Stany ofert musi wtedy wysyłać {kto}.</p>
                  ) : (
                    <>
                      <p>Kompletor prowadzi zamówienia z tego konta: statusy, numery nadania, pakowanie, wysyłkę i faktury. Stany ofert wysyła dalej {kto}. Stany dołączysz później jednym kliknięciem.</p>
                      <Warunki w={warunkiBezStanow} />
                    </>
                  )
                }
                tak={tryb === 'PRACA' ? 'Wyłącz stany' : 'Włącz bez stanów'}
                powodWylaczenia={bezTrybu ?? (tryb === 'PRACA' || mozna(warunkiBezStanow) ? undefined : 'Spełnij warunki z listy niżej')}
              >
                {tryb === 'PRACA' ? 'Wyłącz tylko stany ofert' : 'Włącz tryb pracy bez stanów'}
              </PrzyciskPotwierdz>
            </form>
          )}
          {prowadziZamowienia(tryb) && (
            <form action={zmienTryb}>
              <input type="hidden" name="konto" value={kod} />
              <input type="hidden" name="tryb" value="CIEN" />
              <PrzyciskPotwierdz
                wariant="cichy"
                tytul="Wrócić do trybu „Tylko podgląd”?"
                pytanie="Kompletor przestanie prowadzić zamówienia z tego konta i wysyłać zmiany do sklepu. Zamówienia, oferty i ustawienia zostają."
                tak="Wróć do podglądu"
                powodWylaczenia={bezTrybu}
              >
                Wróć do trybu „Tylko podgląd”
              </PrzyciskPotwierdz>
            </form>
          )}
        </div>
        {!prowadziZamowienia(tryb) && <Warunki w={warunki} />}
        {tryb === 'MIESZANY' && (
          // konto w trybie mieszanym (ustawionym poza panelem) wraca do podglądu
          // z panelu, także gdy instancja nie pozwala na tryb pracy; inaczej blokowałoby zapis klucza BaseLinkera
          <form action={zmienTryb} className="kn-akcje">
            <input type="hidden" name="konto" value={kod} />
            <input type="hidden" name="tryb" value="CIEN" />
            <PrzyciskPotwierdz
              wariant="cichy"
              tytul="Przełączyć całe konto na „Tylko podgląd”?"
              pytanie="Kompletor przestanie prowadzić zamówienia z tego konta i wysyłać zmiany do sklepu. Zamówienia, oferty i ustawienia zostają."
              tak="Przełącz na podgląd"
              powodWylaczenia={bezTrybu}
            >
              Przełącz całe konto na „Tylko podgląd”
            </PrzyciskPotwierdz>
          </form>
        )}
      </Karta>

      {allegro && <PolaczenieAllegro kod={kod} s={allegro} now={now} />}
      {woo && <PolaczenieWoo kod={kod} s={woo} now={now} maKlucze={kluczOdczytu || !!e.envPrefix} maKluczZapisu={kluczZapisu} />}

      <Karta
        id="polaczenie"
        tytul="Połączenie"
        opis={k.testCheckedAt ? `Sprawdzone ${when(k.testCheckedAt, now)}.` : 'Jeszcze nie sprawdzano.'}
      >
        {k.testOk !== null && (
          <Baner ton={k.testOk ? 'sukces' : 'blad'} tytul={k.testOk ? 'Działa.' : 'Nie działa.'} rola="status">
            {k.testMessage}
          </Baner>
        )}
        <div className="kn-akcje">
          <form action={sprawdzPolaczenie}>
            <input type="hidden" name="konto" value={kod} />
            <Przycisk wariant="glowny" type="submit" ladowanie={e.testPending} powodWylaczenia={allegro && !allegro.polaczone ? 'Najpierw połącz z Allegro' : undefined}>
              Sprawdź połączenie
            </Przycisk>
          </form>
          <form action={pobierzOfertyKonta}>
            <input type="hidden" name="konto" value={kod} />
            <Przycisk type="submit" ladowanie={e.offersPending} powodWylaczenia={e.canReadOffers ? undefined : 'Ten rodzaj konta nie podaje listy ofert'}>
              Pobierz oferty
            </Przycisk>
          </form>
        </div>
        {!e.canReadOffers && <p className="muted small">Oferty przypiszesz ręcznie z listy „Do przypisania”, gdy przyjdą zamówienia.</p>}
        <Odswiezanie aktywne={e.testPending || e.offersPending} />
      </Karta>

      {e.manifest?.config.some((f) => f.key === 'nipMetaKey') && <PolaZamowienia kod={kod} wykryte={e.wykryteMeta} config={e.config} now={now} />}

      {zapis && <ZapisDoSklepu kod={kod} e={zapis} now={now} aktywne={k.active} warunki={warunkiZ} uprawnienie={mozeTryb} />}

      <Karta
        id="oferty"
        tytul="Oferty"
        opis={`Powiązane: ${int(k.offers)}${e.ostatniPrzebieg ? ` · ostatnie pobranie ${when(e.ostatniPrzebieg.startedAt, now)}` : ''}`}
      >
        {!e.ostatniPrzebieg ? (
          <p className="muted small">Ofert jeszcze nie pobierano.</p>
        ) : (
          <>
            {e.ostatniPrzebieg.status === 'FAILED' && <Baner ton="blad">Pobranie nie udało się: {e.ostatniPrzebieg.error ?? 'błąd'}</Baner>}
            {st && (
              <ListaOpisowa
                kolumny={2}
                pozycje={[
                  { etykieta: 'Odczytane oferty', wartosc: int(st.read ?? 0) },
                  { etykieta: 'Nowe produkty / nowe oferty', wartosc: `${int(st.newProducts ?? 0)} / ${int(st.newOffers ?? 0)}` },
                  ...((st.proposals ?? 0) > 0 ? [{ etykieta: 'Do zatwierdzenia (firma z BaseLinkerem)', wartosc: int(st.proposals ?? 0) }] : []),
                  { etykieta: 'Bez zmian', wartosc: int(st.kept ?? 0) },
                  { etykieta: 'Bez SKU / niepewne / brak produktu', wartosc: `${int(st.bezSku ?? 0)} / ${int(st.wieloznaczne ?? 0)} / ${int(st.bezProduktu ?? 0)}` },
                  // EAN ze szczegółów ofert (Allegro), najwyżej 200 odczytów na pobranie
                  ...(st.ean && st.ean.sprawdzone + st.ean.zZapisu + st.ean.pozostale > 0
                    ? [
                        {
                          etykieta: 'EAN ze szczegółów ofert',
                          wartosc: `${int(st.ean.znalezione + st.ean.zZapisu)} z EAN, ${int(st.ean.bezEan)} bez EAN${st.ean.pozostale > 0 ? `, kolejne ${int(st.ean.pozostale)} przy następnym pobraniu` : ''}`,
                        },
                      ]
                    : []),
                  { etykieta: 'Błędy', wartosc: int(st.errors ?? 0) },
                  ...((st.ordersRemapped ?? 0) > 0 ? [{ etykieta: 'Przeliczone zamówienia', wartosc: int(st.ordersRemapped ?? 0) }] : []),
                  // zdjęcia dla produktów bez zdjęcia (pobiera worker w tle)
                  // najwyżej 200 zleceń na przebieg, reszta przy następnym „Pobierz oferty”
                  ...((st.zdjecia?.zlecone ?? 0) > 0
                    ? [
                        {
                          etykieta: 'Zdjęcia produktów do pobrania',
                          wartosc: (st.zdjecia?.pominiete ?? 0) > 0 ? `${int(st.zdjecia?.zlecone ?? 0)} (kolejne ${int(st.zdjecia?.pominiete ?? 0)} przy następnym pobraniu)` : int(st.zdjecia?.zlecone ?? 0),
                        },
                      ]
                    : []),
                ]}
              />
            )}
            {(st?.rozjazdy?.length ?? 0) > 0 && (
              <p className="small">
                Inna ilość w kanale niż dostępna u nas: {st!.rozjazdy!.slice(0, 10).map((r) => `${r.sku} (kanał ${r.kanal}, u nas ${r.stan})`).join(', ')}
                {st!.rozjazdy!.length > 10 && ` i ${st!.rozjazdy!.length - 10} więcej`}. Stan u nas się nie zmienia.
              </p>
            )}
            {e.ostatniPrzebieg.issues.length > 0 && (
              <Zaawansowane tytul={`Błędy pobrania (${e.ostatniPrzebieg.issues.length})`}>
                <ul className="small">
                  {e.ostatniPrzebieg.issues.map((i, n) => (
                    <li key={n} className="kn-zawijaj">
                      <span className="kn-nazwa-pola">{i.ref}</span>: {i.message}
                    </li>
                  ))}
                </ul>
              </Zaawansowane>
            )}
          </>
        )}
      </Karta>

      <Karta id="przypisz" tytul="Do przypisania" opis="Oferty bez produktu i pozycje zamówień, które na nie czekają.">
        <form method="get" action={`/ustawienia/kanaly/${encodeURIComponent(kod)}#przypisz`} className="kn-szukaj">
          <PoleTekstowe id="p-szukaj" name="szukaj" etykieta="Szukaj produktu (SKU albo nazwa)" defaultValue={q} maxLength={100} />
          <Przycisk type="submit">Szukaj</Przycisk>
        </form>
        {q && (
          <div className="small">
            {found.length === 0 ? (
              <p className="muted">Nic nie znaleziono.</p>
            ) : (
              <ul className="plain">
                {found.map((p) => (
                  <li key={p.id} className="kn-zawijaj">
                    <span className="kn-nazwa-pola">{p.sku}</span> · {p.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <datalist id="skus">
          {found.map((p) => (
            <option key={p.id} value={p.sku}>
              {p.title}
            </option>
          ))}
        </datalist>
        {e.doPrzypisania.length === 0 ? (
          <p className="muted small">Wszystko przypisane.</p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th scope="col">Oferta</th>
                <th scope="col">Powód</th>
                <th scope="col">Przypisz do produktu</th>
              </tr>
            </thead>
            <tbody>
              {e.doPrzypisania.map((x) => (
                <tr key={x.externalId} className={x.orders > 0 ? 'row-warn' : undefined}>
                  <td data-label="Oferta">
                    <span className="kn-nazwa-pola">{x.externalId}</span>
                    {x.name && <span className="sub kn-zawijaj">{x.name}</span>}
                    {x.sku && <span className="sub mono">SKU {x.sku}</span>}
                    {x.orders > 0 && <span className="sub">czeka zamówień: {int(x.orders)}</span>}
                  </td>
                  <td data-label="Powód">
                    <Odznaka ton="ostrzezenie" rozmiar="sm">
                      {STATE_LABEL[x.state] ?? x.state}
                    </Odznaka>
                    {x.note && <span className="sub">{x.note}</span>}
                  </td>
                  <td data-label="Przypisz" className="nolabel">
                    <form action={przypisz} className="kn-przypisz">
                      <input type="hidden" name="konto" value={kod} />
                      <input type="hidden" name="oferta" value={x.externalId} />
                      <PoleTekstowe id={`sku-${x.externalId}`} name="sku" etykieta="SKU produktu" list="skus" required maxLength={100} defaultValue={found.length === 1 ? found[0]!.sku : ''} />
                      <PoleLiczbowe id={`szt-${x.externalId}`} name="sztuk" etykieta="Sztuk na ofertę" className="kn-sztuk" inputMode="numeric" pattern="[0-9]{1,6}" defaultValue="1" required />
                      <Przycisk wariant="glowny" rozmiar="sm" type="submit">
                        Przypisz
                      </Przycisk>
                    </form>
                    {!hasWfirma && (
                      <form action={utworzProdukt} className="kn-akcje">
                        <input type="hidden" name="konto" value={kod} />
                        <input type="hidden" name="oferta" value={x.externalId} />
                        <Przycisk rozmiar="sm" type="submit">
                          Utwórz produkt
                        </Przycisk>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Karta>

      <LaczenieOfert db={ctx.db} refKonta={ref} kod={kod} po={one(sp.laczenie) === 'EAN' ? 'EAN' : one(sp.laczenie) === 'SKU' ? 'SKU' : null} maListe={!!e.ostatniPrzebieg} mozePowiazac={ctx.permissions.has('produkty.dodawanie')} />

      <Karta id="ustawienia" tytul="Ustawienia i klucze" akcje={<Link href="/pomoc/integracje">Skąd wziąć klucz</Link>}>
        {!e.manifest ? (
          <p className="muted small">Ten rodzaj konta nie ma jeszcze adaptera: ustawień nie da się tu zmienić.</p>
        ) : (
          <form action={zapiszKonto} aria-label="Ustawienia i klucze konta" autoComplete="off">
            <input type="hidden" name="konto" value={kod} />
            {e.envPrefix && <p className="muted small">Konto czyta też ustawienia i klucze z pliku konfiguracji serwera. Wartości wpisane tutaj mają pierwszeństwo.</p>}
            <div className="kn-pola">
              <PoleTekstowe id="k-nazwa" name="nazwa" etykieta="Nazwa w panelu" maxLength={80} required defaultValue={k.name} />
              {podstawowe.map((u) => (
                <PoleUstawieniaWejscie key={u.field.key} field={u.field} value={u.value} />
              ))}
              {e.sekrety.filter((x) => x.field.required).map((s) => (
                <PoleSekretuWejscie key={s.field.name} field={s.field} savedAt={s.savedAt} />
              ))}
            </div>
            {(() => {
              const nazwy = [...rzadkie.map((u) => etykietaPola(u.field.key)), ...kluczeRzadkie.map((x) => x.field.description.split(' (')[0]!), 'identyfikator konta']
              return (
              <Zaawansowane tytul={`Zaawansowane (${nazwy.slice(0, 3).join(', ')}${nazwy.length > 3 ? '…' : ''})`}>
                <p className="muted small">
                  Identyfikator konta: <span className="kn-nazwa-pola">{k.channelAccountId}</span> (w poleceniach administratora i w historii zmian)
                </p>
                <div className="kn-pola">
                  {rzadkie.map((u) => (
                    <PoleUstawieniaWejscie key={u.field.key} field={u.field} value={u.value} />
                  ))}
                  {kluczeRzadkie.map((x) => (
                    <PoleSekretuWejscie key={x.field.name} field={x.field} savedAt={x.savedAt} />
                  ))}
                </div>
              </Zaawansowane>
              )
            })()}
            <PasekZapisu />
          </form>
        )}
      </Karta>

      <Karta id="aktywne" tytul={k.active ? 'Wyłączenie konta' : 'Konto wyłączone'}>
        <p className="small">
          {k.active
            ? 'Wyłączone konto nie jest czytane. Zamówienia, oferty i klucze zostają, można je włączyć z powrotem.'
            : 'Konto nie jest czytane. Po włączeniu system wraca do odczytu od miejsca, w którym skończył.'}
        </p>
        <form action={ustawAktywne}>
          <input type="hidden" name="konto" value={kod} />
          <input type="hidden" name="aktywne" value={k.active ? 'nie' : 'tak'} />
          {k.active ? (
            <PrzyciskPotwierdz wariant="niebezpieczny" tytul="Wyłączyć konto?" pytanie="Kompletor przestanie czytać zamówienia z tego konta. Dane, oferty i klucze zostają." tak="Wyłącz konto">
              Wyłącz konto
            </PrzyciskPotwierdz>
          ) : (
            <Przycisk wariant="glowny" type="submit">
              Włącz konto
            </Przycisk>
          )}
        </form>
      </Karta>
    </>
  )
}
