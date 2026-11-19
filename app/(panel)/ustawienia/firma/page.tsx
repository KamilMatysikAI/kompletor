// Ustawienia → Dane firmy: jeden profil firmy — nazwa, NIP, adres, e-mail i telefon biura,
// rachunek bankowy. Czytają go: szkic faktury KSeF (sprzedawca), nadawca przesyłek, maile i wydruki. Tylko z
// uprawnieniem `ustawienia`. Logo firmy (osłona uploadu, lib/firma/logo.ts) — karta zamówienia, lista
// wysyłkowa i maile; ekran na klockach fundamentu UI, wynik zapisu jako toast.
import { Baner, Karta, NaglowekStrony, PasekZapisu, PoleTekstowe, Przycisk, PrzyciskPotwierdz } from '@/app/ui'
import { LOGO_POLICY, logoUrlPanelu, logoZUstawien } from '@/lib/firma/logo'
import { brakiProfilu, parseProfilFirmy } from '@/lib/firma/profil'
import { requirePermission } from '@/lib/panel/kontekst'
import { ToastZAdresu } from '../kanaly/toast-z-adresu'
import { usunLogoFirmy, wgrajLogoFirmy, zapiszDaneFirmy } from './akcje'

export const metadata = { title: 'Dane firmy' }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

const SUKCES: Record<string, string> = { '1': 'Zapisano dane firmy.', logo: 'Zapisano logo firmy.', 'logo-usuniete': 'Logo usunięte.' }

export default async function DaneFirmy({ searchParams }: Props) {
  const ctx = await requirePermission('ustawienia')
  const sp = await searchParams
  const org = await ctx.db.organization.findFirst({ select: { settings: true } })
  const p = parseProfilFirmy(org?.settings ?? null)
  const logo = logoZUstawien(org?.settings ?? null)
  const raw = obj(obj(org?.settings)['firma'])
  const adres = obj(raw['adres'])
  const v = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const braki = brakiProfilu(p)
  const blad = one(sp.blad)?.slice(0, 200)
  const sukces = SUKCES[one(sp.zapisano) ?? ''] ?? null
  const mb = Math.round(LOGO_POLICY.maxBytes / 1024 / 1024)
  return (
    <>
      <NaglowekStrony
        tytul="Dane firmy"
        podtytul={`Jedno miejsce na dane firmy. Korzystają z nich faktury (sprzedawca), przesyłki (nadawca), maile do klientów i wydruki. Strefa czasowa: ${p.strefaCzasowa}, waluta: ${p.waluta}.`}
      />
      <ToastZAdresu sukces={sukces} blad={blad} />
      {braki.length > 0 && (
        <Baner ton="ostrzezenie" rola="status">
          Do uzupełnienia: {braki.join(', ')}.
        </Baner>
      )}
      <form action={zapiszDaneFirmy} className="stack" aria-label="Dane firmy">
        <Karta tytul="Firma">
          <div className="grid g2">
            <PoleTekstowe id="f-nazwa" etykieta="Pełna nazwa (jak w rejestrze)" name="nazwa" defaultValue={v(raw, 'nazwa')} maxLength={200} autoComplete="organization" />
            <PoleTekstowe id="f-nip" etykieta="NIP" name="nip" defaultValue={v(raw, 'nip')} maxLength={20} inputMode="numeric" />
            <PoleTekstowe id="f-ulica" etykieta="Ulica i numer" name="ulica" defaultValue={v(adres, 'ulica')} maxLength={200} autoComplete="address-line1" />
            <PoleTekstowe id="f-kod" etykieta="Kod pocztowy" name="kodPocztowy" defaultValue={v(adres, 'kodPocztowy')} maxLength={12} placeholder="00-000" autoComplete="postal-code" />
            <PoleTekstowe id="f-miasto" etykieta="Miasto" name="miasto" defaultValue={v(adres, 'miasto')} maxLength={100} autoComplete="address-level2" />
            <PoleTekstowe id="f-kraj" etykieta="Kraj (kod, np. PL)" name="kodKraju" defaultValue={v(adres, 'kodKraju') || 'PL'} maxLength={2} />
          </div>
        </Karta>
        <Karta tytul="Kontakt i rachunek" opis="E-mail biura dostaje alerty i maile wewnętrzne, kontaktowy widzi klient">
          <div className="grid g2">
            <PoleTekstowe id="f-email" etykieta="E-mail kontaktowy (dla klientów)" name="email" type="email" defaultValue={v(raw, 'email')} maxLength={254} />
            <PoleTekstowe id="f-biuro" etykieta="E-mail biura" name="emailBiura" type="email" defaultValue={v(raw, 'emailBiura')} maxLength={254} />
            <PoleTekstowe id="f-tel" etykieta="Telefon" name="telefon" type="tel" defaultValue={v(raw, 'telefon')} maxLength={20} autoComplete="tel" />
            <PoleTekstowe id="f-rach" etykieta="Rachunek bankowy" name="rachunek" defaultValue={v(raw, 'rachunek')} maxLength={40} inputMode="numeric" />
          </div>
          <div className="actions">
            <PasekZapisu />
          </div>
        </Karta>
      </form>
      <Karta
        tytul="Logo"
        opis="Na karcie zamówienia, liście wysyłkowej i w mailach do klientów. Sklep z własnym logo w Ustawieniach → Komunikacja i poczta → Poczta ma w mailach swoje."
      >
        {logo ? (
          <div className="stack">
            {/* eslint-disable-next-line @next/next/no-img-element -- obraz z własnej trasy z sesją, bez optymalizacji Next */}
            <img src={logoUrlPanelu(logo)} alt="Logo firmy" width={Math.min(300, logo.szerokosc)} style={{ maxWidth: '100%', height: 'auto', background: '#fff', padding: 8, border: '1px solid var(--line, #ddd)', borderRadius: 6 }} />
            <p className="muted small">
              {logo.szerokosc} × {logo.wysokosc} px
            </p>
          </div>
        ) : (
          <p className="muted">Brak logo: wydruki i maile pokazują nazwę firmy.</p>
        )}
        <form action={wgrajLogoFirmy} className="stack" aria-label="Wgraj logo">
          <div className="field ui-pole">
            <label htmlFor="f-logo">{logo ? 'Zmień logo' : 'Wgraj logo'}</label>
            <input className="input" id="f-logo" name="logo" type="file" accept="image/png,image/jpeg" required aria-describedby="f-logo-pomoc" />
            <p className="ui-pomoc" id="f-logo-pomoc">
              PNG albo JPG, do {mb} MB. Najlepiej poziome, na przezroczystym albo białym tle. Kompletor zmniejszy je sam.
            </p>
          </div>
          <div className="actions">
            <Przycisk type="submit" wariant="glowny">
              {logo ? 'Zapisz nowe logo' : 'Zapisz logo'}
            </Przycisk>
          </div>
        </form>
        {logo && (
          <form action={usunLogoFirmy} className="actions">
            <PrzyciskPotwierdz pytanie="Usunąć logo firmy? Wydruki i maile pokażą nazwę firmy." wariant="niebezpieczny" tak="Usuń logo">
              Usuń logo
            </PrzyciskPotwierdz>
          </form>
        )}
      </Karta>
    </>
  )
}
