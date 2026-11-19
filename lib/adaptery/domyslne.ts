// Domyślny rejestr adapterów aplikacji. Fałszywy adapter nie jest tu wpisany — testy i demo
// rejestrują go jawnie, żeby konto produkcyjne nigdy nie trafiło do kanału w pamięci.
import { ALLEGRO_DEFINITION } from './allegro'
import { ALLEGRO_WYSYLAM_DEFINITION } from './allegro-wysylam'
import { ALLEGRO_WYSYLAM_ZAPIS_DEFINITION } from './allegro-wysylam-zapis'
import { ALLEGRO_ZAPIS_DEFINITION } from './allegro-zapis'
import { BASE_COURIER_DEFINITION } from './basecourier'
import { BASE_COURIER_ZAPIS_DEFINITION } from './basecourier-zapis'
import { DPD_DEFINITION, DPD_ZAPIS_DEFINITION } from './dpd'
import { IDOSELL_DEFINITION, IDOSELL_ZAPIS_DEFINITION } from './idosell'
import { INPOST_SHIPX_DEFINITION } from './inpost'
import { INPOST_SHIPX_ZAPIS_DEFINITION } from './inpost-zapis'
import { KSEF_DEFINITION } from './ksef'
import { MIRAKL_EMPIK_DEFINITION, MIRAKL_EMPIK_ZAPIS_DEFINITION } from './mirakl-empik'
import { GLS_DEFINITION, GLS_ZAPIS_DEFINITION } from './gls'
import { ORLEN_DEFINITION, ORLEN_ZAPIS_DEFINITION } from './orlenpaczka'
import { PP_DEFINITION, PP_ZAPIS_DEFINITION } from './pocztapolska'
import { PRESTA_DEFINITION, PRESTA_ZAPIS_DEFINITION } from './prestashop'
import { AdapterRegistry } from './rejestr'
import { SHOPER_DEFINITION, SHOPER_ZAPIS_DEFINITION } from './shoper'
import { WOO_DEFINITION } from './woo'
import { WOO_ZAPIS_DEFINITION } from './woo-zapis'

export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry([
    WOO_DEFINITION,
    WOO_ZAPIS_DEFINITION,
    SHOPER_DEFINITION,
    SHOPER_ZAPIS_DEFINITION,
    MIRAKL_EMPIK_DEFINITION,
    MIRAKL_EMPIK_ZAPIS_DEFINITION,
    ALLEGRO_DEFINITION,
    ALLEGRO_ZAPIS_DEFINITION,
    PRESTA_DEFINITION,
    PRESTA_ZAPIS_DEFINITION,
    IDOSELL_DEFINITION,
    IDOSELL_ZAPIS_DEFINITION,
    BASE_COURIER_DEFINITION,
    BASE_COURIER_ZAPIS_DEFINITION,
    ALLEGRO_WYSYLAM_DEFINITION,
    ALLEGRO_WYSYLAM_ZAPIS_DEFINITION,
    INPOST_SHIPX_DEFINITION,
    INPOST_SHIPX_ZAPIS_DEFINITION,
    DPD_DEFINITION,
    DPD_ZAPIS_DEFINITION,
    ORLEN_DEFINITION,
    ORLEN_ZAPIS_DEFINITION,
    GLS_DEFINITION,
    GLS_ZAPIS_DEFINITION,
    PP_DEFINITION,
    PP_ZAPIS_DEFINITION,
    KSEF_DEFINITION,
  ])
}
