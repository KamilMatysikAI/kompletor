// Kody błędów ADE GLS (Fault `faultcode`) → rodzaj wyniku Kompletora. Konektor Open Integration Platform
// (integrators/courier/gls/v1.0.0/src/integration.py, ae43d1e) nie klasyfikuje kodów: każdy Fault zamienia na HTTP 400.
// Klasyfikacja jest nasza: znane kody z tabeli, reszta po przedrostku rodziny. [NIEPEWNE: lista kodów do potwierdzenia
// na koncie testowym ADE, docs/integracje/gls.md; nieznany kod = TRWALY, czyli człowiek, nigdy ciche ponowienie.]
//
// PRZEJSCIOWY = ADE odmówiło przed wykonaniem z powodu sesji albo limitu (nowa sesja wystarczy); TRWALY = dane,
// uprawnienia, stan przesyłki. Tabela dotyczy tylko kodów ADE (`err_*`), czyli odmowy przed wykonaniem; Fault bez kodu
// ADE (`SOAP-ENV:Server`, nieczytelny) przy zapisie klient zapisu zwraca jako NIEJEDNOZNACZNY bez kodu.
import type { FailureKind } from './kontrakt'

export type KlasaGls = Extract<FailureKind, 'TRWALY' | 'PRZEJSCIOWY'>

export const KODY_GLS: Readonly<Record<string, { opis: string; klasa: KlasaGls }>> = {
  err_user_webapi_auth_error: { opis: 'zły login albo hasło ADE', klasa: 'TRWALY' },
  err_user_webapi_access_denied: { opis: 'konto ADE bez dostępu do API', klasa: 'TRWALY' },
  err_sess_not_found: { opis: 'sesja ADE wygasła albo nie istnieje', klasa: 'PRZEJSCIOWY' },
  err_sess_expired: { opis: 'sesja ADE wygasła', klasa: 'PRZEJSCIOWY' },
  err_sess_create_problem: { opis: 'ADE nie otworzyło sesji', klasa: 'PRZEJSCIOWY' },
  err_sess_limit_exceeded: { opis: 'za dużo otwartych sesji ADE (limit 10 na firmę)', klasa: 'PRZEJSCIOWY' },
  err_cons_not_found: { opis: 'przesyłki o tym identyfikatorze nie ma w ADE', klasa: 'TRWALY' },
  err_cons_rzipcode_invalid: { opis: 'zły kod pocztowy odbiorcy', klasa: 'TRWALY' },
  err_cons_rcity_invalid: { opis: 'zła miejscowość odbiorcy', klasa: 'TRWALY' },
  err_cons_weight_invalid: { opis: 'zła waga paczki', klasa: 'TRWALY' },
  err_cons_srv_cod_amount_invalid: { opis: 'zła kwota pobrania', klasa: 'TRWALY' },
  err_cons_srv_sds_id_invalid: { opis: 'zły punkt GLS (ParcelShop)', klasa: 'TRWALY' },
  err_parcel_not_found: { opis: 'paczki o tym numerze nie ma w ADE', klasa: 'TRWALY' },
}

/** Rodziny kodów po przedrostku, gdy kodu nie ma w tabeli (od najdłuższego przedrostka). */
const RODZINY: readonly [string, KlasaGls, string][] = [
  ['err_sess_', 'PRZEJSCIOWY', 'problem z sesją ADE'],
  ['err_user_', 'TRWALY', 'odmowa konta ADE'],
  ['err_cons_', 'TRWALY', 'ADE odrzuciło dane przesyłki'],
  ['err_parcel', 'TRWALY', 'ADE odrzuciło dane paczki'],
  ['err_pickup_', 'TRWALY', 'ADE odrzuciło potwierdzenie nadania'],
]

/** Klasa i opis kodu ADE; nieznany kod = TRWALY (człowiek), z kodem w opisie. */
export function klasaKoduGls(kod: string): { klasa: KlasaGls; opis: string } {
  const znany = KODY_GLS[kod]
  if (znany) return znany
  const r = RODZINY.find(([p]) => kod.startsWith(p))
  return r ? { klasa: r[1], opis: `${r[2]} (${kod})` } : { klasa: 'TRWALY', opis: `nieznany błąd ADE (${kod})` }
}
