// Ustawienia → Automatyczne akcje → przycisk „Wczytaj szablon”: gotowe przepływy (statusy + reguły) do
// wyboru jednym kliknięciem i podgląd zmian przed zapisem. Bez pozycji w menu (reguła ekranów pomocniczych): wejście
// z nagłówka „Automatycznych akcji” i z listy uruchomienia na pulpicie. Tylko z uprawnieniem `ustawienia`.
import Link from 'next/link'
import { Baner, Karta, NaglowekStrony, Odznaka, PrzyciskLink, PrzyciskPotwierdz, StatusFirmy } from '@/app/ui'
import { liczbaRegul, podgladSzablonu, SZABLONY, szablonPrzeplywu, type SzablonPrzeplywu } from '@/lib/automaty/szablony'
import { ZDARZENIA } from '@/lib/automaty/schemat'
import { requirePermission } from '@/lib/panel/kontekst'
import { isKolorStatusu, sortujStatusy } from '@/lib/panel/statusy'
import { wczytajSzablonAkcja } from './akcje'
import './szablony.css'

export const metadata = { title: 'Szablony przepływów' }
export const dynamic = 'force-dynamic'

/** Główny tor statusów szablonu: aktywne, bez etapów „problemowych” i anulowania (to nie kroki przepływu). */
const POZA_TOREM = new Set(['ANULOWANE', 'DO_WYJASNIENIA', 'REKLAMACJA'])
function tor(sz: SzablonPrzeplywu) {
  const glowne = sortujStatusy(sz.statuses).filter((s) => s.active && !POZA_TOREM.has(s.baseStatus))
  // szablon odbioru pomija etapy wysyłki, szablon kuriera etap odbioru i „Odebrane” (tor kończy się na „Wysłane”, jak w opisie)
  const uzyte = new Set(sz.automationRules.flatMap((r) => [...r.actions.flatMap((a) => (a.typ === 'ustawStatus' ? [a.status] : [])), ...r.conditions.flatMap((c) => (c.typ === 'status' ? c.wartosci : []))]))
  const odbior = uzyte.has('DO_ODBIORU')
  return glowne.filter((s) => (odbior ? !['ZBIERANIE', 'ZEBRANE', 'DO_WYSLANIA', 'WYSLANE'].includes(s.baseStatus) : s.baseStatus !== 'DO_ODBIORU' && s.baseStatus !== 'ZEBRANE' && !(uzyte.has('WYSLANE') && s.baseStatus === 'ODEBRANE')))
}

function Tor({ sz }: { sz: SzablonPrzeplywu }) {
  const t = tor(sz)
  return (
    <ol className="sz-tor" aria-label={`Kolejne statusy: ${t.map((s) => s.name).join(', ')}`}>
      {t.map((s) => (
        <li key={s.key}>
          <StatusFirmy rozmiar="sm" etykieta={{ nazwa: s.name, bazowy: s.name, kolor: isKolorStatusu(s.color) ? s.color : 'szary' }} />
        </li>
      ))}
    </ol>
  )
}

export default async function SzablonyPrzeplywow({ searchParams }: { searchParams: Promise<{ szablon?: string }> }) {
  const ctx = await requirePermission('ustawienia')
  const { szablon } = await searchParams
  const wybrany = szablonPrzeplywu(szablon)
  const plan = wybrany ? await podgladSzablonu(ctx.db, wybrany.id) : null
  return (
    <>
      <NaglowekStrony
        tytul="Wczytaj szablon przepływu"
        podtytul="Gotowe statusy i automatyczne akcje dla typowego sposobu pracy. Wybierz najbliższy, sprawdź, co się zmieni, a potem dopasuj reguły do siebie."
        akcje={
          <PrzyciskLink href="/ustawienia/automaty" wariant="cichy">
            Wróć do automatycznych akcji
          </PrzyciskLink>
        }
      />
      <ul className="sz-siatka" aria-label="Szablony przepływów">
        {SZABLONY.map((s) => {
          const aktywny = wybrany?.id === s.id
          return (
            <li key={s.id} className="sz-szablon" data-wybrany={aktywny || undefined}>
              <h2>
                <Link href={`/ustawienia/automaty/szablony?szablon=${s.id}#podglad`} aria-current={aktywny ? 'true' : undefined}>
                  {s.nazwa}
                </Link>
              </h2>
              <p className="sz-dla-kogo">{s.dlaKogo}</p>
              <Tor sz={s} />
              <ul className="sz-opis small">
                {s.opis.slice(1).map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
              <p className="small muted sz-licznik">{liczbaRegul(s.automationRules.length)}</p>
            </li>
          )
        })}
      </ul>

      {wybrany && plan && (
        <Karta
          id="podglad"
          className="sz-mt"
          tytul={`Co się zmieni: ${wybrany.nazwa}`}
          opis={plan.powodTrybu}
          akcje={<Odznaka ton={plan.tryb === 'PELNY' ? 'sukces' : 'info'}>{plan.tryb === 'PELNY' ? 'cały przepływ' : 'nowa grupa reguł'}</Odznaka>}
        >
          {plan.ostrzezenia.map((o) => (
            <Baner key={o} ton="ostrzezenie">
              {o}
            </Baner>
          ))}
          {plan.tryb === 'PELNY' ? (
            plan.zmianyStatusow.length > 0 && (
              <>
                <h3>Statusy</h3>
                <ul className="sz-zmiany">
                  {plan.zmianyStatusow.map((z) => (
                    <li key={z.klucz}>
                      {z.ukryty ? (
                        <>
                          „{z.bylo}” <span className="muted">zostanie ukryty (ten przepływ go nie używa)</span>
                        </>
                      ) : (
                        <>
                          „{z.bylo}” <span className="muted">zmieni nazwę na</span> „{z.bedzie}”
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : (
            <>
              <h3>Twoje statusy zostają</h3>
              <p className="small muted">Reguły szablonu będą ustawiać Twoje statusy tego samego etapu pracy:</p>
              <ul className="sz-zmiany">
                {plan.dopasowania
                  .filter((d) => !d.takiSam)
                  .map((d) => (
                    <li key={d.szablon}>
                      „{d.nazwaSzablonu}” <span className="muted">w regułach to Twój status</span> „{d.nazwa}”
                    </li>
                  ))}
                {plan.dopasowania.every((d) => d.takiSam) && <li>Nazwy statusów są takie same jak w szablonie.</li>}
              </ul>
            </>
          )}
          <h3>Reguły {plan.wlaczone ? '(od razu włączone)' : `(w grupie „${plan.grupa}”, wyłączone)`}</h3>
          <ul className="sz-reguly">
            {plan.reguly.map((r) => (
              <li key={r.nazwa} data-pominieta={r.pominieta ? true : undefined}>
                <span>{r.nazwa}</span>
                <span className="small muted">{r.pominieta ? `nie przejdzie: ${r.pominieta}` : ZDARZENIA[r.zdarzenie as keyof typeof ZDARZENIA]?.nazwa}</span>
              </li>
            ))}
          </ul>
          <form action={wczytajSzablonAkcja} className="sz-mt">
            <input type="hidden" name="szablon" value={wybrany.id} />
            <PrzyciskPotwierdz
              wariant="glowny"
              tytul={`Wczytać szablon „${wybrany.nazwa}”?`}
              pytanie={
                plan.tryb === 'PELNY'
                  ? 'Statusy dostaną nazwy z szablonu, a reguły zaczną działać od razu. Wszystko zmienisz potem w Ustawieniach.'
                  : 'Twoje statusy i reguły zostaną bez zmian. Reguły szablonu trafią do nowej grupy, wyłączone.'
              }
              tak="Wczytaj szablon"
            >
              Wczytaj szablon
            </PrzyciskPotwierdz>
          </form>
        </Karta>
      )}
      {!wybrany && <p className="small muted sz-mt">Kliknij nazwę szablonu, żeby zobaczyć, co zmieni w Twojej firmie. Nic się nie zapisze bez potwierdzenia.</p>}
    </>
  )
}
