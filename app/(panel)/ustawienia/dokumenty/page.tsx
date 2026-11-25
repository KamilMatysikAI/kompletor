// Ustawienia → Dokumenty sprzedaży: kto prowadzi stan magazynu, program do faktur
// (dostawca dokumentów sprzedaży), kiedy wystawiać dokument, seria numeracji dla KSeF i pozycja wysyłki. Tylko
// z uprawnieniem `ustawienia`. Bez programu do faktur zamówienie zamyka się po wysyłce bez dokumentu.
// ekran na klockach fundamentu UI, wynik zapisu jako toast; numeracja i pola KSeF zwinięte, gdy
// program to nie KSeF; pozycja wysyłki osobno, bo czyta ją każdy program.
// cały ekran to jeden formularz z jednym PasekZapisu (źródło stanu razem z dokumentami), wynik jako toast.
import { Karta, NaglowekStrony, PasekZapisu, ToastZAdresuZapisu } from '@/app/ui'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { ETYKIETA_MOMENTU, MOMENTY_WYSTAWIENIA } from '@/lib/dokumenty/ustawienia'
import { programyDoWyboru, widokDokumentow } from '@/lib/dokumenty/zapis'
import { produkcjaOtwarta } from '@/lib/ksef/api/bramka'
import { ETYKIETA_SRODOWISKA, SRODOWISKA_FIRMY, parseKonfiguracjaKsef } from '@/lib/ksef/konfiguracja'
import { OKRESY_RESETU } from '@/lib/ksef/numeracja'
import { KSEF_TOKEN } from '@/lib/ksef/wysylka'
import { requirePermission } from '@/lib/panel/kontekst'
import { ETYKIETA_ZRODLA, ZRODLA_STANU } from '@/lib/rdzen/zrodlo-stanu'
import { zapiszDokumenty } from './akcje'

export const metadata = { title: 'Dokumenty sprzedaży' }

const WYNIK = { '1': 'Zapisano.', zrodlo: 'Zapisano. Zmieniło się też to, kto prowadzi stan magazynu.', 'bez-zmian': 'Nic się nie zmieniło.' }

const OPIS_ZRODLA = {
  KOMPLETOR: 'Towar schodzi ze stanu przy „Do wysyłki / Do odbioru”. Stan poprawiasz korektą na karcie produktu. Dokument sprzedaży to osobna sprawa.',
  WFIRMA: 'Stan to kopia magazynu wFirmy: towar schodzi fakturą z dokumentem WZ, a odczyt z wFirmy to potwierdza.',
} as const
const RESET = { ROK: 'co rok', MIESIAC: 'co miesiąc', NIGDY: 'nigdy' } as const

export default async function DokumentySprzedazy() {
  const ctx = await requirePermission('ustawienia')
  const v = await widokDokumentow(ctx.db)
  const programy = programyDoWyboru(defaultRegistry().list())
  const u = v.ustawienia
  const ksef = u.program === 'ksef' || u.program === 'ksef.fa3.v1'
  // token KSeF tylko jako informacja „zapisany / brak” (wartości nie czytamy), produkcja z bramki serwera
  const maToken = (await ctx.db.integrationSecret.count({ where: { name: KSEF_TOKEN, channel: null, channelAccountId: null } })) > 0
  const nip = parseKonfiguracjaKsef((await ctx.db.organization.findFirst({ select: { settings: true } }))?.settings ?? null).sprzedawca?.nip ?? null
  const prod = produkcjaOtwarta(nip)
  return (
    <>
      <NaglowekStrony
        tytul="Dokumenty sprzedaży"
        podtytul="Kto prowadzi stan magazynu, w jakim programie powstają faktury i kiedy. Dane sprzedawcy na fakturze bierzemy z Ustawienia → Dokumenty i faktury → Dane firmy."
      />
      <ToastZAdresuZapisu komunikaty={WYNIK} />

      <form action={zapiszDokumenty} className="stack" aria-label="Dokumenty sprzedaży">
      <Karta tytul="Kto prowadzi stan magazynu" akcje={<span className="chip">{ETYKIETA_ZRODLA[v.zrodloStanu]}</span>}>
          <fieldset className="plain" disabled={!!v.zmianaZrodlaZablokowana}>
            <legend className="sr">Źródło stanu</legend>
            {ZRODLA_STANU.map((z) => (
              <label key={z} className="checkrow">
                <input type="radio" name="zrodlo" value={z} defaultChecked={v.zrodloStanu === z} disabled={z === 'WFIRMA' && !v.magazynWfirmy} />
                <span>
                  <b>{ETYKIETA_ZRODLA[z]}</b>
                  <span className="sub">
                    {OPIS_ZRODLA[z]}
                    {z === 'WFIRMA' && !v.magazynWfirmy ? ' Niedostępne: magazyn nie jest połączony z magazynem wFirmy.' : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {v.zmianaZrodlaZablokowana && <p className="small muted">{v.zmianaZrodlaZablokowana}</p>}
      </Karta>

        <Karta tytul="Program do faktur" opis={v.programWywnioskowany ? 'Ustawione automatycznie na podstawie magazynu; zapisz, żeby potwierdzić' : undefined}>
          <fieldset className="plain">
            <legend className="sr">Program do faktur</legend>
            {programy.map((p) => (
              <label key={p.program} className="checkrow">
                <input type="radio" name="program" value={p.program} defaultChecked={u.program === p.program} />
                <span>
                  <b>{p.nazwa}</b>
                  <span className="sub">{p.opis}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </Karta>

        <Karta
          tytul="Wystawianie z Kompletora"
          opis={u.fakturyWlaczone && u.fakturyWlaczoneOd ? `Włączone od ${new Date(u.fakturyWlaczoneOd).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}` : undefined}
        >
          <input type="hidden" name="fakturyWlaczonePole" value="tak" />
          <label className="checkrow">
            <input type="checkbox" name="fakturyWlaczone" value="tak" defaultChecked={u.fakturyWlaczone} />
            <span>
              Wystawiaj faktury z Kompletora
              <span className="sub">
                Kompletor sam wystawia fakturę w wFirmie albo wysyła ją do KSeF (numer i PDF zobaczysz na karcie zamówienia i na liście Faktury). Wyłączone = faktury wystawiasz jak dotąd, np. w BaseLinkerze albo ręcznie. Działa z programem wFirma (klucze wFirmy w konfiguracji firmy) albo KSeF bezpośrednio (seria numeracji i token KSeF niżej); zamówienia sklepów w trybie „Tylko podgląd” zostają poza tym (ich faktury wystawia BaseLinker). Pierwszą fakturę po włączeniu sprawdź w programie albo w KSeF.
              </span>
            </span>
          </label>
          {!!v.spakowaneBezFaktury && (
            <p className="muted small" role="note">
              Spakowane zamówienia bez faktury: {v.spakowaneBezFaktury}. Po włączeniu zostaną bez faktury z Kompletora (Kompletor wystawia tylko dla zamówień spakowanych po włączeniu): wystaw je jak dotąd i kliknij na karcie „Wyślij bez faktury”.
            </p>
          )}
        </Karta>

        <Karta tytul="Kiedy wystawiać" opis={v.zrodloStanu === 'WFIRMA' ? 'Przy stanie z wFirmy faktura zdejmuje towar, więc powstaje zawsze po spakowaniu, dla każdego zamówienia' : undefined}>
          <div className="grid g2">
            <div className="field">
              <label htmlFor="d-kiedy">Dokument powstaje</label>
              <select className="input" id="d-kiedy" name="wystawiajPrzy" defaultValue={u.wystawiajPrzy}>
                {MOMENTY_WYSTAWIENIA.map((m) => (
                  <option key={m} value={m}>
                    {ETYKIETA_MOMENTU[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="d-rodzaj">Rodzaj dokumentu</label>
              <select className="input" id="d-rodzaj" name="rodzaj" defaultValue={u.rodzaj}>
                <option value="faktura">faktura</option>
                <option value="paragon" disabled>
                  paragon (żaden podłączony program go nie wystawia)
                </option>
              </select>
            </div>
          </div>
          <label className="checkrow">
            <input type="checkbox" name="tylkoNaZadanie" value="tak" defaultChecked={u.tylkoNaZadanie} />
            <span>Tylko gdy klient prosi o fakturę (np. podał NIP)</span>
          </label>
          <label className="checkrow">
            <input type="checkbox" name="przedWysylka" value="tak" defaultChecked={u.przedWysylka} />
            <span>
              Dokument przed wysyłką
              <span className="sub">Towar nie wyjdzie, dopóki dokument nie jest wystawiony. Wymaga programu do faktur. Przy stanie z wFirmy faktura jest zawsze przed wysyłką.</span>
            </span>
          </label>
          <label className="checkrow">
            <input type="checkbox" name="wzBezFaktury" value="tak" defaultChecked={v.wzBezFaktury} disabled={u.program !== 'wfirma' || !!v.wzBezFakturyNiedostepne} />
            <span>
              WZ przy wysyłce bez faktury
              <span className="sub">
                Gdy faktura z Kompletora nie wychodzi i zamówienie wysyłasz przyciskiem „Wyślij bez faktury”, Kompletor zakłada w wFirmie dokument WZ, zamiast zostawiać pozycję „Wydane bez dokumentu” do ręcznego zamknięcia. Wymaga włączonego „Wystawiaj faktury z Kompletora”.{' '}
                {u.program !== 'wfirma' ? 'Dostępne tylko z programem wFirma (stan magazynu prowadzony w wFirmie).' : (v.wzBezFakturyNiedostepne ?? '')}
              </span>
            </span>
          </label>
          <input type="hidden" name="korektyWlaczonePole" value="tak" />
          <label className="checkrow">
            <input type="checkbox" name="korektyWlaczone" value="tak" defaultChecked={v.korektyWlaczone} disabled={u.program !== 'wfirma'} />
            <span>
              Korekty faktur przy zwrotach z Kompletora
              <span className="sub">
                Na karcie zwrotu przycisk „Zleć korektę faktury” wystawia korektę w wFirmie. Wyłączone = korektę wystawiasz w wFirmie sam i kończysz zwrot przyciskiem „Korekta wystawiona poza Kompletorem”. Wymaga włączonego „Wystawiaj faktury z Kompletora”. Pierwszą korektę po włączeniu sprawdź w wFirmie.
                {u.program !== 'wfirma' ? ' Dostępne tylko z programem wFirma.' : ''}
              </span>
            </span>
          </label>
          <input type="hidden" name="walutaZamowieniaPole" value="tak" />
          <label className="checkrow">
            <input type="checkbox" name="walutaZamowienia" value="tak" defaultChecked={v.walutaZamowienia} disabled={u.program !== 'wfirma'} />
            <span>
              Faktury w walucie zamówienia
              <span className="sub">
                Zamówienie w innej walucie niż złotówki (np. Allegro w Czechach) dostaje fakturę w wFirmie w tej walucie, z cenami i wysyłką jak w zamówieniu. Wyłączone: takie zamówienie czeka na fakturę wystawioną ręcznie. Zamówienia sprzed włączenia: sprawdź w wFirmie, czy mają fakturę, i kliknij „Ponów fakturę” na karcie.
                {u.program !== 'wfirma' ? ' Dostępne tylko z programem wFirma.' : ''}
              </span>
            </span>
          </label>
        </Karta>

        <Karta tytul="Pozycja wysyłki na dokumencie" opis="Nazwa i stawka VAT kosztu wysyłki na fakturze (w każdym programie)">
          <div className="grid g2">
            <div className="field">
              <label htmlFor="d-wys">Nazwa pozycji wysyłki</label>
              <input className="input" id="d-wys" name="wysylkaNazwa" defaultValue={v.wysylka.nazwa} maxLength={100} />
            </div>
            <div className="field">
              <label htmlFor="d-wys-vat">VAT wysyłki</label>
              <select className="input" id="d-wys-vat" name="wysylkaStawka" defaultValue={v.wysylka.stawkaVat}>
                {['23', '8', '5', '0', 'zw'].map((s) => (
                  <option key={s} value={s}>
                    {s === 'zw' ? 'zw' : `${s}%`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Karta>

        <Karta
          zwijana
          otwarta={ksef}
          tytul="Numeracja i KSeF (tylko KSeF bezpośrednio)"
          opis={ksef ? 'Używane przy programie KSeF bezpośrednio' : 'Nieużywane przy wybranym programie (np. wFirma numeruje faktury sama); rozwiń, gdy przechodzisz na KSeF'}
        >
          <div className="grid g3">
            <div className="field">
              <label htmlFor="d-kod">Kod serii</label>
              <input className="input" id="d-kod" name="seriaKod" defaultValue={v.seria?.kod ?? ''} maxLength={40} placeholder="FV" />
            </div>
            <div className="field">
              <label htmlFor="d-wzor">Wzór numeru</label>
              <input className="input" id="d-wzor" name="seriaWzor" defaultValue={v.seria?.wzor ?? 'FV/{NR}/{MM}/{RRRR}'} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="d-reset">Numeracja od nowa</label>
              <select className="input" id="d-reset" name="seriaReset" defaultValue={v.seria?.reset ?? 'ROK'}>
                {OKRESY_RESETU.map((r) => (
                  <option key={r} value={r}>
                    {RESET[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="d-zw">Podstawa zwolnienia (dla „zw”)</label>
              <input className="input" id="d-zw" name="podstawaZwolnienia" defaultValue={v.podstawaZwolnienia ?? ''} maxLength={256} />
            </div>
          </div>
          <p className="small muted">
            Wzór: %N albo {'{NR}'} numer (obowiązkowy), %D dzień, %M miesiąc, %Y rok (np. %N/%M/%Y). Numer przydziela się dopiero przy wysyłce faktury, nigdy w szkicu, i nigdy się nie powtarza.
          </p>
          <div className="grid g3">
            <div className="field">
              <label htmlFor="d-kkod">Kod serii korekt</label>
              <input className="input" id="d-kkod" name="seriaKorektKod" defaultValue={v.seriaKorekt?.kod ?? ''} maxLength={40} placeholder="KOR" />
            </div>
            <div className="field">
              <label htmlFor="d-kwzor">Wzór numeru korekty</label>
              <input className="input" id="d-kwzor" name="seriaKorektWzor" defaultValue={v.seriaKorekt?.wzor ?? '%N/%M/%Y/K'} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="d-kreset">Numeracja korekt od nowa</label>
              <select className="input" id="d-kreset" name="seriaKorektReset" defaultValue={v.seriaKorekt?.reset ?? 'ROK'}>
                {OKRESY_RESETU.map((r) => (
                  <option key={r} value={r}>
                    {RESET[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid g2">
            <div className="field">
              <label htmlFor="d-srod">Środowisko KSeF</label>
              <select className="input" id="d-srod" name="srodowiskoKsef" defaultValue={v.srodowiskoKsef}>
                {SRODOWISKA_FIRMY.map((s) => (
                  <option key={s} value={s}>
                    {ETYKIETA_SRODOWISKA[s]}
                  </option>
                ))}
              </select>
              <span className="small muted">
                {v.srodowiskoKsef === 'PROD'
                  ? prod.otwarta
                    ? 'Faktury idą do prawdziwego KSeF.'
                    : `Wybrane produkcyjne, ale nic nie wyjdzie: ${prod.powod}`
                  : 'Testowe KSeF przyjmuje faktury bez skutków podatkowych. Produkcyjne otwiera dodatkowo operator serwera.'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="d-token">Token KSeF firmy</label>
              <input className="input" id="d-token" name="ksefToken" type="password" autoComplete="off" placeholder={maToken ? 'zapisany (wpisz nowy, żeby zmienić)' : 'brak: wklej token z aplikacji KSeF'} maxLength={2000} />
              <span className="small muted">Zapisujemy go zaszyfrowany i nigdy nie pokazujemy. Token generujesz w Aplikacji Podatnika KSeF dla NIP-u firmy.</span>
            </div>
          </div>
          <label className="checkrow">
            <input type="checkbox" name="konsumenciDoKsef" value="tak" defaultChecked={v.konsumenciDoKsef} />
            <span>Faktury dla osób prywatnych (bez NIP) też do KSeF</span>
          </label>
          {Object.keys(v.kodyVatWfirmy).length > 0 && (
            <p className="small muted">
              Kody VAT konta wFirmy: {Object.entries(v.kodyVatWfirmy).map(([s, id]) => `${s} → ${id}`).join(', ')} (ustawia konfiguracja firmy).
            </p>
          )}
        </Karta>
        <PasekZapisu />
      </form>
    </>
  )
}
