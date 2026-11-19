// Karta produktu → zakładka „Powiązania”: oferty produktu na kontach kanałów (stan powiązania,
// przelicznik, ostatnio wysłany stan, źródło), „Odłącz” i „Przepnij” ze skutkiem, „Powiąż z ofertą” z wyszukiwarką
// zapisanej listy ofert i (firma z wFirmą) ręczne wskazanie towaru wFirmy. Wyszukiwanie przez adres (?oferta=, ?konto=,
// ?towar=, ?przepnij= + ?cel=), więc działa bez skryptów i daje się odświeżyć. Zmiany z uprawnieniem `produkty.dodawanie`
// (jak edycja karty); „Pobierz oferty” na koncie kanału zostaje przy `ustawienia`.
import Link from 'next/link'
import type { PrismaClient, Unit } from '@prisma/client'
import { Baner, Karta, Odznaka, PrzyciskLink, PustyStan, Tabela, Wybor, PoleTekstowe, Przycisk } from '@/app/ui'
import type { AccountRef } from '@/lib/panel/dane'
import { accountName } from '@/lib/panel/dane'
import { int, qty, when } from '@/lib/panel/format'
import { kodKonta, parseKodKonta } from '@/lib/kanaly/konta'
import { PERMISSIONS } from '@/lib/auth/uprawnienia'
import { maListeOfert, powiazaniaProduktu, STAN_POWIAZANIA, szukajOfert, szukajProduktowDoPrzepiecia, szukajTowarowWfirmy, type ProduktDoPrzepiecia, type WierszPowiazania } from '@/lib/produkty/powiazania'
import { OdlaczOferte, PowiazZOferta, PrzepnijOferte, WskazTowar } from './powiazania'

type Parametry = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export interface ProduktPowiazan {
  id: string
  sku: string
  unit: Unit
  kind: 'STOCKED' | 'BUNDLE' | 'DIGITAL'
  wfirmaGoodId: string | null
}

const przelicznikTekst = (n: number, unit: Unit) => (n === 1 ? '1:1' : `1 szt. = ${qty(n, unit)}`)

function pytanieOdlacz(w: WierszPowiazania, unit: Unit): string[] {
  const out = [`Kolejne zamówienia z oferty ${w.externalId} przyjdą bez produktu i trafią do „Do wyjaśnienia”, a oferta wróci na listę „Do przypisania” konta.`]
  const z = w.skutek.przedZbieraniem + w.skutek.wToku
  if (z > 0) out.push(`Zamówienia już przyjęte (${int(z)}, zarezerwowane ${qty(w.skutek.zarezerwowane, unit)}) zostają z tym produktem i rezerwacją.`)
  out.push(
    w.lastPushedQty !== null
      ? `Kompletor przestanie wysyłać stan na tę ofertę. W sklepie zostaje ostatnio wysłany stan: ${w.lastPushedQty}. Jeśli oferta nie ma sprzedawać, wyłącz ją w sklepie.`
      : 'Kompletor przestanie wysyłać stan na tę ofertę.',
  )
  return out
}

function pytaniePrzepnij(w: WierszPowiazania, unit: Unit, cel: ProduktDoPrzepiecia, przelicznik: number): string[] {
  const out = [
    `Oferta ${w.externalId} zacznie sprzedawać „${cel.title}” (SKU ${cel.sku}), ${przelicznik === 1 ? '1 szt. oferty = 1 szt. produktu' : `1 szt. oferty = ${qty(przelicznik, cel.unit)}`} (przelicznik zmienisz w polu obok).`,
  ]
  if (w.skutek.przedZbieraniem > 0)
    out.push(`Zamówienia przed zbieraniem (${int(w.skutek.przedZbieraniem)}) przejdą na „${cel.title}”: rezerwacja tego produktu (${qty(w.skutek.zarezerwowane, unit)} razem) zostanie zwolniona, a nowego założona. Czego nie ma na stanie, trafi do „brakuje”.`)
  else out.push('Żadne otwarte zamówienie nie czeka na tę ofertę przed zbieraniem: zmienia się tylko powiązanie.')
  if (w.skutek.wToku > 0) out.push(`Zamówienia już zbierane, spakowane albo w wysyłce (${int(w.skutek.wToku)}) zostają z tym produktem.`)
  out.push('W sklepie nic się nie zmienia: to powiązanie w Kompletorze.')
  return out
}

export async function SekcjaPowiazan({
  db,
  p,
  accs,
  sp,
  canEdit,
  canSettings,
  hasWfirma,
  now,
}: {
  db: PrismaClient
  p: ProduktPowiazan
  accs: AccountRef[]
  sp: Parametry
  canEdit: boolean
  canSettings: boolean
  hasWfirma: boolean
  now: Date
}) {
  const q = (one(sp.oferta) ?? '').slice(0, 100)
  const przepnijId = (one(sp.przepnij) ?? '').slice(0, 40)
  const qCel = (one(sp.cel) ?? '').slice(0, 100)
  const kontoKod = one(sp.konto) ?? ''
  const konto = kontoKod ? parseKodKonta(kontoKod) : null
  const qTowar = (one(sp.towar) ?? '').slice(0, 100)
  const wfirmaMozliwa = hasWfirma && p.kind !== 'BUNDLE'
  const [wiersze, maLista, wyniki, towary, obecnyTowar, cele] = await Promise.all([
    powiazaniaProduktu(db, p.id),
    canEdit ? maListeOfert(db) : Promise.resolve(false),
    canEdit && q ? szukajOfert(db, q, { konto }) : Promise.resolve([]),
    canEdit && wfirmaMozliwa && qTowar ? szukajTowarowWfirmy(db, qTowar) : Promise.resolve([]),
    wfirmaMozliwa && p.wfirmaGoodId ? db.wfirmaGood.findFirst({ where: { id: p.wfirmaGoodId }, select: { id: true, code: true, name: true } }) : Promise.resolve(null),
    canEdit && przepnijId && qCel ? szukajProduktowDoPrzepiecia(db, qCel, p.id) : Promise.resolve([] as ProduktDoPrzepiecia[]),
  ])
  const przepinana = canEdit && przepnijId ? wiersze.find((w) => w.id === przepnijId && w.stan === 'AKTYWNA') : undefined
  // przelicznik dla celu: ten z oferty, gdy jednostka ta sama; inaczej 1 szt. albo 1000 g
  const przelicznikCelu = (c: ProduktDoPrzepiecia) => (przepinana && c.unit === p.unit ? przepinana.qtyBasePerOffer : c.unit === 'KG' ? 1000 : 1)
  const domyslnyPrzelicznik = p.unit === 'KG' ? 1000 : 1
  const adres = `/produkty/${p.id}`
  const kanaly = accs.filter((a) => a.channel !== 'RECZNE')

  return (
    <Karta
      id="powiazania"
      tytul="Powiązania"
      opis="Oferty w sklepach i na platformach, które sprzedają ten produkt. Zmiana jest tylko w Kompletorze: w sklepie nic się nie zmienia."
    >
      <Tabela
        id="produkt-powiazania"
        etykieta="Oferty powiązane z produktem"
        kolumny={[
          { klucz: 'konto', etykieta: 'Konto' },
          { klucz: 'oferta', etykieta: 'Oferta' },
          { klucz: 'stan', etykieta: 'Stan' },
          { klucz: 'przelicznik', etykieta: 'Przelicznik', wyrownanie: 'prawo' },
          { klucz: 'wyslane', etykieta: 'Ostatnio wysłany stan', wyrownanie: 'prawo' },
          { klucz: 'zrodlo', etykieta: 'Źródło' },
          ...(canEdit ? [{ klucz: 'akcje', etykieta: 'Akcje' }] : []),
        ]}
        wiersze={wiersze.map((w) => {
          const s = STAN_POWIAZANIA[w.stan]
          const kod = kodKonta(w)
          return {
            id: w.id,
            etykieta: `${accountName(accs, w.channel, w.channelAccountId)} ${w.externalId}`,
            ton: w.stan === 'PROPOZYCJA' ? ('uwaga' as const) : undefined,
            komorki: {
              konto: accountName(accs, w.channel, w.channelAccountId),
              oferta: (
                <>
                  <span className="mono">{w.externalId}</span>
                  {w.nazwa && <span className="pw-sub">{w.nazwa}</span>}
                  {(w.sku || w.ean) && <span className="pw-sub mono">{[w.sku && `SKU ${w.sku}`, w.ean && `EAN ${w.ean}`].filter(Boolean).join(' · ')}</span>}
                </>
              ),
              stan: (
                <>
                  <Odznaka ton={s.ton} rozmiar="sm">
                    {s.etykieta}
                  </Odznaka>
                  {w.skutek.przedZbieraniem + w.skutek.wToku > 0 && <span className="pw-sub">otwarte zamówienia: {int(w.skutek.przedZbieraniem + w.skutek.wToku)}</span>}
                </>
              ),
              przelicznik: przelicznikTekst(w.qtyBasePerOffer, p.unit),
              wyslane: w.lastPushedQty === null ? '—' : `${w.lastPushedQty}${w.lastPushedAt ? ` · ${when(w.lastPushedAt, now)}` : ''}`,
              zrodlo: w.zrodlo,
              akcje: canEdit ? (
                <div className="pw-akcje">
                  {w.stan === 'AKTYWNA' ? (
                    <>
                      <PrzyciskLink href={`${adres}?przepnij=${encodeURIComponent(w.id)}#przepnij`} rozmiar="sm" wariant="drugorzedny">
                        Przepnij na inny produkt
                      </PrzyciskLink>
                      <OdlaczOferte produkt={p.id} powiazanie={w.id} pytanie={pytanieOdlacz(w, p.unit)} />
                    </>
                  ) : (
                    <>
                      <PowiazZOferta produkt={p.id} konto={kod} oferta={w.externalId} przelicznik={w.qtyBasePerOffer} etykieta={w.externalId} przycisk={w.stan === 'PROPOZYCJA' ? 'Zatwierdź' : 'Powiąż ponownie'} />
                      {w.stan === 'PROPOZYCJA' && <OdlaczOferte produkt={p.id} powiazanie={w.id} pytanie={['Propozycja zostanie odrzucona: oferta wróci na listę „Do przypisania” konta i nie powiąże się sama przy kolejnym pobraniu ofert.']} />}
                    </>
                  )}
                </div>
              ) : null,
            },
          }
        })}
        pustyStan={
          <PustyStan tytul="Produkt nie sprzedaje się jeszcze w żadnej ofercie">
            Znajdź jego ofertę niżej w „Powiąż z ofertą”. Oferty powiązane automatycznie (po SKU albo importem katalogu) pojawią się tu same po pobraniu ofert.
          </PustyStan>
        }
      />

      {!canEdit && <p className="small">Powiązania zmienia osoba z uprawnieniem „{PERMISSIONS['produkty.dodawanie']}”.</p>}

      {przepinana && (
        <section className="pw-sekcja" id="przepnij" aria-labelledby="h-pw-przepnij">
          <h3 id="h-pw-przepnij">
            Przepnij ofertę {przepinana.externalId} ({accountName(accs, przepinana.channel, przepinana.channelAccountId)}) na inny produkt
          </h3>
          <p className="small">
            Znajdź produkt, który ta oferta ma sprzedawać, i kliknij „Przepnij na ten”. Przed zapisem zobaczysz nazwę, SKU i liczbę zamówień, których to dotyczy.
            {przepinana.skutek.wToku > 0 && ` Zamówienia już zbierane, spakowane albo w wysyłce (${int(przepinana.skutek.wToku)}) zostają z tym produktem.`}
          </p>
          <form method="get" action={`${adres}#przepnij`} className="pw-szukaj" role="search" aria-label="Szukaj produktu docelowego">
            <input type="hidden" name="przepnij" value={przepinana.id} />
            <PoleTekstowe id="pw-cel" etykieta="SKU, nazwa albo EAN produktu" name="cel" defaultValue={qCel} maxLength={100} required minLength={2} />
            <Przycisk type="submit">Szukaj</Przycisk>
            <PrzyciskLink href={`${adres}#powiazania`} wariant="cichy">
              Anuluj
            </PrzyciskLink>
          </form>
          {qCel && (
            <Tabela
              id="produkt-przepnij-cel"
              etykieta="Produkty, na które można przepiąć ofertę"
              kolumny={[
                { klucz: 'produkt', etykieta: 'Produkt' },
                { klucz: 'stan', etykieta: 'Dostępne', wyrownanie: 'prawo' },
                { klucz: 'akcja', etykieta: 'Przepnij' },
              ]}
              wiersze={cele.map((c) => ({
                id: c.id,
                etykieta: `${c.sku} ${c.title}`,
                komorki: {
                  produkt: (
                    <>
                      <Link href={`/produkty/${c.id}`}>{c.title}</Link>
                      <span className="pw-sub mono">
                        SKU {c.sku} · {c.unit === 'KG' ? 'na wagę' : 'sztuki'}
                        {c.kind === 'BUNDLE' ? ' · zestaw' : c.kind === 'DIGITAL' ? ' · bez stanu' : ''}
                      </span>
                    </>
                  ),
                  stan: c.dostepne === null ? '—' : qty(c.dostepne, c.unit),
                  akcja: (
                    <PrzepnijOferte
                      produkt={p.id}
                      powiazanie={przepinana.id}
                      cel={c.id}
                      przelicznik={przelicznikCelu(c)}
                      pytanie={pytaniePrzepnij(przepinana, p.unit, c, przelicznikCelu(c))}
                      etykieta={`${c.sku} ${c.title}`}
                    />
                  ),
                },
              }))}
              pustyStan={<PustyStan tytul="Nie znaleziono produktu">Szukamy wśród włączonych produktów po SKU, nazwie i EAN. Wpisz co najmniej 2 znaki.</PustyStan>}
            />
          )}
        </section>
      )}

      {canEdit && (
        <section className="pw-sekcja" aria-labelledby="h-pw-szukaj">
          <h3 id="h-pw-szukaj">Powiąż z ofertą</h3>
          {!maLista ? (
            <Baner ton="info" akcja={canSettings ? <PrzyciskLink href="/ustawienia/kanaly" rozmiar="sm">Kanały sprzedaży</PrzyciskLink> : undefined}>
              {canSettings
                ? 'Nie ma jeszcze zapisanej listy ofert. Na koncie kanału kliknij „Pobierz oferty” (tylko odczyt ze sklepu), potem wróć tutaj.'
                : 'Nie ma jeszcze zapisanej listy ofert. Pobiera ją osoba z dostępem do ustawień: Ustawienia → Sprzedaż i kanały → Kanały sprzedaży → konto → „Pobierz oferty”.'}
            </Baner>
          ) : (
            <>
              <form method="get" action={`${adres}#powiazania`} className="pw-szukaj" role="search" aria-label="Szukaj oferty">
                <PoleTekstowe id="pw-q" etykieta="SKU, nazwa, EAN albo numer oferty" name="oferta" defaultValue={q || p.sku} maxLength={100} />
                <Wybor id="pw-konto" etykieta="Konto" name="konto" defaultValue={konto ? kodKonta(konto) : ''} opcje={[{ wartosc: '', etykieta: 'Wszystkie konta' }, ...kanaly.map((a) => ({ wartosc: kodKonta(a), etykieta: a.name }))]} />
                {qTowar && <input type="hidden" name="towar" value={qTowar} />}
                <Przycisk type="submit">Szukaj</Przycisk>
              </form>
              {q && (
                <Tabela
                  id="produkt-szukaj-oferty"
                  etykieta="Znalezione oferty"
                  kolumny={[
                    { klucz: 'konto', etykieta: 'Konto' },
                    { klucz: 'oferta', etykieta: 'Oferta' },
                    { klucz: 'teraz', etykieta: 'Teraz' },
                    { klucz: 'akcja', etykieta: 'Powiąż' },
                  ]}
                  wiersze={wyniki.map((o) => {
                    const kod = kodKonta(o)
                    const ten = o.powiazanie?.productId === p.id
                    const inny = o.powiazanie && !ten && o.powiazanie.stan === 'AKTYWNA'
                    return {
                      id: `${kod}|${o.externalId}`,
                      etykieta: `${accountName(accs, o.channel, o.channelAccountId)} ${o.externalId}`,
                      komorki: {
                        konto: accountName(accs, o.channel, o.channelAccountId),
                        oferta: (
                          <>
                            <span className="mono">{o.externalId}</span>
                            {o.nazwa && <span className="pw-sub">{o.nazwa}</span>}
                            {(o.sku || o.ean) && <span className="pw-sub mono">{[o.sku && `SKU ${o.sku}`, o.ean && `EAN ${o.ean}`].filter(Boolean).join(' · ')}</span>}
                          </>
                        ),
                        teraz: !o.powiazanie ? (
                          <Odznaka ton="ostrzezenie" rozmiar="sm">
                            Bez produktu
                          </Odznaka>
                        ) : ten ? (
                          <Odznaka ton={STAN_POWIAZANIA[o.powiazanie.stan].ton} rozmiar="sm">
                            {o.powiazanie.stan === 'AKTYWNA' ? 'Ten produkt' : STAN_POWIAZANIA[o.powiazanie.stan].etykieta}
                          </Odznaka>
                        ) : (
                          <>
                            <Link href={`/produkty/${o.powiazanie.productId}#powiazania`}>{o.powiazanie.title}</Link>
                            <span className="pw-sub mono">
                              SKU {o.powiazanie.sku} · {STAN_POWIAZANIA[o.powiazanie.stan].etykieta.toLowerCase()}
                            </span>
                          </>
                        ),
                        akcja:
                          ten && o.powiazanie?.stan === 'AKTYWNA' ? (
                            <span className="pw-sub">Już powiązana</span>
                          ) : (
                            <PowiazZOferta
                              produkt={p.id}
                              konto={kod}
                              oferta={o.externalId}
                              przelicznik={domyslnyPrzelicznik}
                              etykieta={o.externalId}
                              powodWylaczenia={inny ? 'Oferta sprzedaje inny produkt: przepnij ją z karty tamtego produktu (Powiązania → Przepnij).' : undefined}
                            />
                          ),
                      },
                    }
                  })}
                  pustyStan={
                    <PustyStan tytul="Nie znaleziono oferty">
                      Lista ofert jest z ostatniego „Pobierz oferty” na koncie kanału. Nowej oferty jeszcze na niej nie ma? Pobierz oferty ponownie albo powiąż ją z karty zamówienia, gdy przyjdzie zamówienie.
                    </PustyStan>
                  }
                />
              )}
            </>
          )}
        </section>
      )}

      {wfirmaMozliwa && (
        <section className="pw-sekcja" aria-labelledby="h-pw-wfirma">
          <h3 id="h-pw-wfirma">Towar w wFirmie</h3>
          <p className="small">
            {obecnyTowar ? (
              <>
                Powiązany z towarem <b className="mono">{obecnyTowar.code ?? obecnyTowar.id}</b> ({obecnyTowar.name}). Z niego są ceny, VAT, nazwa na fakturze i stan.
              </>
            ) : p.wfirmaGoodId ? (
              <>Powiązany z towarem wFirmy nr {p.wfirmaGoodId} (nie ma go w kopii towarów: odśwież import katalogu).</>
            ) : (
              <>Nie jest powiązany z towarem wFirmy. Zwykle łączy się sam, gdy SKU = kod towaru; gdy kod jest inny, wskaż towar niżej.</>
            )}
          </p>
          {canEdit && (
            <>
              <form method="get" action={`${adres}#powiazania`} className="pw-szukaj" role="search" aria-label="Szukaj towaru wFirmy">
                <PoleTekstowe id="pw-towar" etykieta="Kod, nazwa albo EAN towaru w wFirmie" name="towar" defaultValue={qTowar} maxLength={100} />
                {q && <input type="hidden" name="oferta" value={q} />}
                <Przycisk type="submit">Szukaj w wFirmie</Przycisk>
              </form>
              {qTowar && (
                <Tabela
                  id="produkt-szukaj-towaru"
                  etykieta="Towary wFirmy"
                  kolumny={[
                    { klucz: 'kod', etykieta: 'Kod' },
                    { klucz: 'nazwa', etykieta: 'Nazwa' },
                    { klucz: 'produkt', etykieta: 'Produkt w Kompletorze' },
                    { klucz: 'akcja', etykieta: 'Powiąż' },
                  ]}
                  wiersze={towary.map((t) => ({
                    id: t.id,
                    etykieta: t.code ?? t.id,
                    komorki: {
                      kod: <span className="mono">{t.code ?? '—'}</span>,
                      nazwa: (
                        <>
                          {t.name}
                          <span className="pw-sub">
                            {t.type === 'service' ? 'usługa' : t.type === 'set' ? 'komplet' : 'towar'} · {t.unit}
                            {t.ean ? ` · EAN ${t.ean}` : ''}
                          </span>
                        </>
                      ),
                      produkt: t.produkt ? (
                        t.produkt.id === p.id ? (
                          'ten produkt'
                        ) : (
                          <Link href={`/produkty/${t.produkt.id}`} className="mono">
                            {t.produkt.sku}
                          </Link>
                        )
                      ) : (
                        '—'
                      ),
                      akcja:
                        t.produkt?.id === p.id ? (
                          <span className="pw-sub">Już powiązany</span>
                        ) : (
                          <WskazTowar
                            produkt={p.id}
                            towar={t.id}
                            powodWylaczenia={t.produkt ? 'Ten towar ma już inny produkt.' : undefined}
                            pytanie={[
                              `Ceny, VAT i nazwa na fakturze będą z towaru „${t.code ?? t.id}”. SKU w Kompletorze zostaje (${p.sku}).`,
                              'Stan produktu weźmie najbliższy odczyt stanów z tego towaru, więc może się zmienić i zmienić to, co dostępne na kanałach.',
                              ...(p.wfirmaGoodId ? [`Obecny towar (${obecnyTowar?.code ?? p.wfirmaGoodId}) przestanie być powiązany z produktem.`] : []),
                            ]}
                          />
                        ),
                    },
                  }))}
                  pustyStan={<PustyStan tytul="Nie znaleziono towaru">Kopia towarów wFirmy jest z ostatniego importu katalogu. Nowy towar pojawi się po kolejnym imporcie.</PustyStan>}
                />
              )}
            </>
          )}
        </section>
      )}
    </Karta>
  )
}
