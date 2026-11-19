// Przeprowadzka z BL: jeden przebieg na zebranych danych — plan, (opcjonalnie) zapis, raport. Wspólne dla
// polecenia (scripts/przeprowadzka.ts) i testów. Bez `zapisz` niczego nie zapisuje w bazie: tylko odczyty klientem
// firmy (powody odmowy, różnice stanów, reguły katalogu).
import type { PrismaClient } from '@prisma/client'
import type { AdapterRegistry } from '../adaptery/rejestr'
import { organizationIdOf } from '../db'
import { loadCatalogRules } from '../organizacje'
import { przelicz, zamowieniaDoPrzeniesienia, type ZebraneDane } from './przebieg'
import { renderMarkdown, zbudujRaport, type RaportJson } from './raport'
import { statusyFirmy } from '@/lib/panel/statusy-firmy-dane'
import { TERMINALNE, type MapaCzlowieka } from './statusy'
import { decyzjaRegul, juzPrzeniesione, OdmowaZapisu, powodyOdmowy, roznicStanow, zapiszPrzeprowadzke, type WynikZapisu, type ZapisOpts } from './zapis'
import { przewidzZamowienia, type WynikZamowienia } from './zamowienia'
import { znacznikAutomatowBl } from './statusy-firmy'

export interface Uruchomienie {
  firma: string
  dane: ZebraneDane
  mapa?: MapaCzlowieka
  registry: Pick<AdapterRegistry, 'get'>
  zapisz: boolean
  now?: Date
  poEtapie?: ZapisOpts['poEtapie']
}

export interface WynikUruchomienia {
  raport: RaportJson
  markdown: string
  zapis: WynikZapisu | null
  powodyOdmowy: string[]
  /** Zamówienia: po zapisie wynik rdzenia, w trybie próbnym przewidywanie (DUPLIKAT dla już przeniesionych). */
  zamowienia: WynikZamowienia[]
}

export async function uruchomPrzeprowadzke(db: PrismaClient, u: Uruchomienie): Promise<WynikUruchomienia> {
  organizationIdOf(db) // tylko klient firmy (RLS) — nigdy systemowy
  const now = u.now ?? new Date()
  const rules = await loadCatalogRules(db)
  const { plan, analiza, otwartePoStatusie, statusyNiepobrane } = przelicz(u.dane, { mapa: u.mapa, registry: u.registry, rules })
  const doPrzeniesienia = zamowieniaDoPrzeniesienia(u.dane, plan)
  const otwarte = new Set(plan.statusy.filter((s) => !TERMINALNE.has(s.status)).map((s) => s.blStatusId))
  const zamowieniaPominiete = u.dane.zamowienia.otwarte.filter((o) => otwarte.has(o.order_status_id)).length - doPrzeniesienia.length
  const powody = await powodyOdmowy(db, plan, otwartePoStatusie, statusyNiepobrane, u.dane.zamowienia.complete)
  // plan statusów firmy z BL i automatów liczony ze stanu PRZED zapisem (raport zapisu pokazuje, co dodał)
  const przed = await statusyFirmy(db)
  const automatyZalozone = znacznikAutomatowBl((await db.organization.findFirst({ select: { settings: true } }))?.settings) !== null
  let zapis: WynikZapisu | null = null
  if (u.zapisz) {
    if (powody.length) throw new OdmowaZapisu(powody)
    zapis = await zapiszPrzeprowadzke(db, u.dane, plan, analiza, doPrzeniesienia, otwartePoStatusie, { now, poEtapie: u.poEtapie })
  }
  // tryb próbny liczy status z tych reguł, które zostaną po zapisie, a zamówienia już przeniesione pokazuje
  // tak, jak zapisze je rdzeń (DUPLIKAT ze statusem z bazy), żeby próba nie obiecywała więcej niż zapis
  const zamowienia = zapis ? zapis.zamowienia : await juzPrzeniesione(db, przewidzZamowienia(doPrzeniesienia, analiza, (await decyzjaRegul(db, plan)).reguly))
  const roznice = analiza ? await roznicStanow(db, analiza) : []
  const statusyFirmyFirmy = (await statusyFirmy(db)).statusy // mapa statusów BL → status firmy w raporcie
  const raport = zbudujRaport({
    statusyFirmy: statusyFirmyFirmy,
    statusyFirmyPrzed: przed.statusy,
    grupyStatusowFirmy: przed.grupy,
    automatyZalozone,
    firma: u.firma,
    tryb: zapis ? 'ZAPIS' : 'PROBNY',
    wygenerowano: now,
    dane: u.dane,
    plan,
    analiza,
    zamowienia,
    zamowieniaPominiete,
    otwartePoStatusie,
    powodyOdmowy: zapis ? [] : powody,
    roznice,
    zapis,
  })
  return { raport, markdown: renderMarkdown(raport, plan), zapis, powodyOdmowy: powody, zamowienia }
}
