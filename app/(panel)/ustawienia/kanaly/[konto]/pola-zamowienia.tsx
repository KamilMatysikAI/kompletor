// Ekran konta WooCommerce → „Pola zamówienia”: które pola dodatkowe zamówienia niosą NIP, punkt odbioru
// i zaznaczenie „chcę fakturę”. Test połączenia czyta same nazwy pól z kilku ostatnich zamówień (bez wartości), ekran
// podpowiada pasującą nazwę i zapisuje ją dopiero po kliknięciu „Użyj”. Ręczna zmiana zostaje w „Zaawansowane”
// sekcji „Ustawienia i klucze”.
import { etykietaPola } from '@/lib/kanaly/platformy'
import { POLA_META, type PoleMeta, proponujPolaMeta, type WykryteKlucze } from '@/lib/kanaly/woo-meta'
import { int, when } from '@/lib/panel/format'
import { Karta, Odznaka, Przycisk, Zaawansowane } from '@/app/ui'
import { uzyjPola } from '../akcje'

const PO_CO: Record<PoleMeta, string> = {
  nipMetaKey: 'NIP trafia na fakturę.',
  pickupPointMetaKey: 'Kod paczkomatu albo punktu trafia do przesyłki.',
  invoiceMetaKey: 'Klient prywatny, który zaznaczył „chcę fakturę”, dostaje fakturę zamiast paragonu.',
}

export function PolaZamowienia({ kod, wykryte, config, now }: { kod: string; wykryte: WykryteKlucze | null; config: Record<string, unknown>; now: Date }) {
  const prop = wykryte ? proponujPolaMeta(wykryte.keys) : {}
  const ile = (k: string) => wykryte?.keys.find((x) => x.key === k)?.orders ?? 0
  return (
    <Karta
      id="pola-zamowienia"
      tytul="Pola zamówienia"
      opis={wykryte ? `Nazwy pól z ${int(wykryte.sample)} ostatnich zamówień, odczyt ${when(new Date(wykryte.at), now)}.` : 'NIP, punkt odbioru i „chcę fakturę” z wtyczek sklepu.'}
    >
      {!wykryte && (
        <p className="muted small">
          Kliknij <a href="#polaczenie">„Sprawdź połączenie”</a>: przejrzymy nazwy pól w kilku ostatnich zamówieniach (bez ich treści) i podpowiemy, które ustawić.
        </p>
      )}
      <dl className="dl">
        {POLA_META.map((pole) => {
          const obecne = typeof config[pole] === 'string' && config[pole] ? String(config[pole]) : null
          const p = prop[pole]
          const inna = p && p.key !== obecne
          return (
            <div key={pole} className="kn-pole-meta">
              <dt>{etykietaPola(pole)}</dt>
              <dd>
                {obecne ? <span className="kn-nazwa-pola">{obecne}</span> : <span className="muted">nie ustawione</span>}
                {obecne && wykryte && !ile(obecne) && (
                  <>
                    {' '}
                    <Odznaka ton="ostrzezenie" rozmiar="sm">
                      nie było w ostatnich zamówieniach
                    </Odznaka>
                  </>
                )}
                <div className="muted small">{PO_CO[pole]}</div>
                {inna && (
                  <form action={uzyjPola} className="kn-akcje">
                    <input type="hidden" name="konto" value={kod} />
                    <input type="hidden" name="pole" value={pole} />
                    <input type="hidden" name="klucz" value={p.key} />
                    <span className="small">
                      Wykryliśmy <span className="kn-nazwa-pola">{p.key}</span> (w {int(p.orders)} z {int(wykryte!.sample)} zamówień).
                    </span>
                    <Przycisk wariant="glowny" rozmiar="sm" type="submit">
                      Użyj
                    </Przycisk>
                  </form>
                )}
                {wykryte && !p && !obecne && <div className="muted small">W ostatnich zamówieniach nie ma pasującego pola.</div>}
              </dd>
            </div>
          )
        })}
      </dl>
      {wykryte && wykryte.keys.length > 0 && (
        <Zaawansowane tytul={`Wszystkie pola z ostatnich zamówień (${wykryte.keys.length})`}>
          <p className="muted small">Same nazwy, bez treści. Inną nazwę wpiszesz w „Ustawienia i klucze” → „Zaawansowane”.</p>
          <ul className="plain small kn-lista-pol">
            {wykryte.keys.map((k) => (
              <li key={k.key}>
                <span className="kn-nazwa-pola">{k.key}</span> <span className="muted">({int(k.orders)})</span>
              </li>
            ))}
          </ul>
        </Zaawansowane>
      )}
    </Karta>
  )
}
