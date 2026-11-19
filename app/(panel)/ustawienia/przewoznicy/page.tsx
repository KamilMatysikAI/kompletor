// Ustawienia → Przewoźnicy: jeden formularz z jednym zapisem — godziny odbioru i reguły
// „sposób dostawy → przewoźnik → moduł wysyłki” — automatyczne statusy wysyłki oraz podgląd, którą regułę dostają sposoby dostawy z ostatnich
// zamówień. Klucze i ustawienia kont przewoźników: przycisk „Konta przewoźników”. Strefy magazynu: własny ekran.
// Tylko z uprawnieniem `ustawienia` (inni dostają 404).
import { NaglowekStrony, Karta, PrzyciskLink } from '@/app/ui'
import { defaultRegistry } from '@/lib/adaptery/domyslne'
import { CARRIER_SHORT, formatHm } from '@/lib/pakowanie/harmonogram'
import { pickupSettings } from '@/lib/pakowanie/dane'
import { CARRIER_LABEL, CHANNEL_LABEL } from '@/lib/panel/format'
import { requirePermission } from '@/lib/panel/kontekst'
import { kontaPrzewoznikow } from '@/lib/wysylka/konta'
import { KANALY_W_REGULE, modulyWysylki, PRZEWOZNICY_W_REGULE, regulyPrzewoznikow, testRegul } from '@/lib/wysylka/reguly'
import { FormularzPrzewoznikow } from './formularz'
import { FormularzAutomatow } from './automaty'
import { automatyWysylki, OPISY_AUTOMATOW, regulyDrogiPrzewoznikow, sledzeniePrzewoznikow } from '@/lib/wysylka/automaty'
import { modulySledzenia, regulyDrogiModulu, sledzenieModulu } from '@/lib/pakowanie/wyslane-po-przyjezdzie'

export const metadata = { title: 'Przewoźnicy' }

const registry = defaultRegistry()

export default async function Przewoznicy() {
  const ctx = await requirePermission('ustawienia')
  const [odbiory, reguly, test, konta, automaty, wyborySledzenia, wyboryRegul] = await Promise.all([pickupSettings(ctx.db), regulyPrzewoznikow(ctx.db, registry), testRegul(ctx.db), kontaPrzewoznikow(ctx.db, registry), automatyWysylki(ctx.db), sledzeniePrzewoznikow(ctx.db), regulyDrogiPrzewoznikow(ctx.db)])
  // konta do wyboru w regule, dla modułów, których przewoźnik ma więcej niż jedno konto
  const kontaModulow: Record<string, { wartosc: string; etykieta: string }[]> = {}
  for (const k of konta) {
    const rodzina = konta.filter((x) => x.glowne === k.glowne)
    if (rodzina.length < 2) continue
    for (const m of k.moduly) kontaModulow[m] = rodzina.map((x) => ({ wartosc: x.sufiks ?? '', etykieta: x.sufiks ? x.nazwa.replace(/^.*\(konto (.*)\)$/, '$1') : 'główne' }))
  }
  return (
    <>
      <NaglowekStrony
        tytul="Przewoźnicy"
        podtytul="Godziny odbioru i który przewoźnik obsługuje który sposób dostawy."
        akcje={
          <>
            <PrzyciskLink href="/ustawienia/przewoznicy/konta" wariant="drugorzedny">
              Konta przewoźników
            </PrzyciskLink>
            <PrzyciskLink href="/pomoc/konfiguracja" wariant="cichy">
              Pomoc
            </PrzyciskLink>
          </>
        }
      />
      <FormularzPrzewoznikow
        odbiory={odbiory.map((s) => ({ carrier: s.carrier, nazwa: CARRIER_SHORT[s.carrier], opis: CARRIER_LABEL[s.carrier], weekdays: s.weekdays, od: formatHm(s.pickupMinute), wyslemy: formatHm(s.promiseUntilMinute), active: s.active, example: !!s.example }))}
        reguly={reguly}
        kanaly={KANALY_W_REGULE.map((c) => ({ wartosc: c, etykieta: CHANNEL_LABEL[c] }))}
        przewoznicy={PRZEWOZNICY_W_REGULE.map((c) => ({ wartosc: c, etykieta: CARRIER_LABEL[c] }))}
        moduly={modulyWysylki(registry)}
        kontaModulow={kontaModulow}
      />
      {/* „Przyjechał kurier” = „Wysłane”, śledzenie przesyłki, anulowanie nieopłaconych w sklepie */}
      <FormularzAutomatow automaty={automaty} opisy={OPISY_AUTOMATOW} sledzenie={modulySledzenia(registry).map((m) => ({ ...m, wlaczone: sledzenieModulu(m.adapterKey, wyborySledzenia) }))}
        reguly={modulySledzenia(registry).map((m) => ({ ...m, wlaczone: regulyDrogiModulu(m.adapterKey, wyboryRegul) }))}
      />
      <Karta tytul="Sprawdzenie na ostatnich zamówieniach" opis="Sposoby dostawy z ostatnich zamówień i reguła, która je dziś obsłuży (według zapisanych reguł)." className="przew-test">
        {test.length === 0 ? (
          <p className="muted">Nie ma jeszcze zamówień do sprawdzenia.</p>
        ) : (
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Kanał</th>
                <th>Sposób dostawy</th>
                <th className="right">Zamówień</th>
                <th>Reguła</th>
              </tr>
            </thead>
            <tbody>
              {test.map((t) => (
                <tr key={`${t.channel}-${t.metoda}`} className={t.regula === null ? 'row-warn' : undefined}>
                  <td data-label="Kanał">{CHANNEL_LABEL[t.channel]}</td>
                  <td data-label="Sposób dostawy">{t.metoda || <span className="muted">(brak nazwy)</span>}</td>
                  <td data-label="Zamówień" className="right num">
                    {t.zamowien}
                  </td>
                  <td data-label="Reguła">{t.regula === null ? <b>brak: „Do wyjaśnienia”</b> : `nr ${t.regula} → ${CARRIER_LABEL[t.carrier!]}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Karta>
    </>
  )
}
