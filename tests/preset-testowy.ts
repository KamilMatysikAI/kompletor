// Stałe testowe: kopia dawnego presetu firmy z seed/acme.ts i seed/acme-kanaly.ts, żeby testy nie zależały
// od pliku seed/presety/acme.json (kod i testy mają działać w repo bez niego). Te same identyfikatory i wartości co
// przed przeniesieniem presetu do JSON; nazwy eksportów bez zmian, żeby w testach zmieniały się tylko importy.
// Porządek nazw i identyfikatorów w testach: osobny krok po scaleniu gałęzi.
import type { PickupScheduleT } from '@/lib/pakowanie/harmonogram'
import type { ZoneRuleT } from '@/lib/pakowanie/strefy'
import type { CarrierRuleT } from '@/lib/rdzen/przewoznicy'
import type { ChannelPreset, OrgPreset } from '@/lib/organizacje'

export const ACME_CARRIER_RULES: CarrierRuleT[] = [
  { priority: 10, channel: 'ALLEGRO', pattern: null, carrier: 'ALLEGRO', shippingModule: 'WYSYLAM_Z_ALLEGRO', adapterKey: 'allegro.wysylam.v1' },
  { priority: 20, channel: null, pattern: 'paczkomat', carrier: 'PACZKOMATY', shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.v1' },
  { priority: 30, channel: null, pattern: 'salon(u)? empik', carrier: 'DPD_EMPIK', shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.v1' },
  { priority: 40, channel: null, pattern: 'dpd|kurier', carrier: 'DPD', shippingModule: 'BASE_COURIER', adapterKey: 'basecourier.v1' },
  { priority: 50, channel: null, pattern: 'osobist', carrier: 'OSOBISTY', shippingModule: 'BRAK' },
]

export const ACME_CHANNEL_CONFIG: { channel: 'WOO' | 'EMPIK' | 'ALLEGRO'; channelAccountId: string; adapterKey: string; config: Record<string, string | number> }[] = [
  { channel: 'WOO', channelAccountId: '7100001', adapterKey: 'woo.rest.v1', config: { baseUrl: 'https://sklepdemo.pl', envPrefix: 'SD_WC' } },
  { channel: 'WOO', channelAccountId: '7100002', adapterKey: 'woo.rest.v1', config: { baseUrl: 'https://hurtdemo.pl', envPrefix: 'LAMPY_WC' } },
  { channel: 'WOO', channelAccountId: '7100003', adapterKey: 'woo.rest.v1', config: { envPrefix: 'KM_WC' } },
  {
    channel: 'ALLEGRO',
    channelAccountId: '71045',
    adapterKey: 'allegro.v1',
    config: { apiUrl: 'https://api.allegro.pl', authUrl: 'https://allegro.pl', envPrefix: 'ALLEGRO_SD', userAgent: 'Cloude Code Automat/1.0 (+https://kompletor.pl)', pollIntervalSec: 60 },
  },
  { channel: 'EMPIK', channelAccountId: '30193', adapterKey: 'mirakl.empik.v1', config: { baseUrl: 'https://empik-prod.mirakl.net/api', envPrefix: 'EMPIK_MIRAKL', pollIntervalSec: 60 } },
]

const ACME_CHANNELS: ChannelPreset[] = [
  { channel: 'WOO', channelAccountId: '7100001', name: 'SklepDemo', blStorageId: 'shop_7100001' },
  { channel: 'WOO', channelAccountId: '7100002', name: 'HurtDemo', blStorageId: 'shop_7100002' },
  { channel: 'WOO', channelAccountId: '7100003', name: 'KolorowyKubek', blStorageId: 'shop_7100003', active: false },
  { channel: 'ALLEGRO', channelAccountId: '71045', name: 'Allegro' },
  { channel: 'EMPIK', channelAccountId: '30193', name: 'Empik' },
  // zamówienia EasyTools przez POST /api/v1/zamowienia (klucz API), bez adaptera odczytu
  { channel: 'EASYTOOLS', channelAccountId: 'acme', name: 'EasyTools' },
]

const withAdapterSettings = (c: ChannelPreset): ChannelPreset => {
  const s = ACME_CHANNEL_CONFIG.find((x) => x.channel === c.channel && x.channelAccountId === c.channelAccountId)
  return s ? { ...c, adapterKey: s.adapterKey, config: s.config } : c
}

/** Godziny odbiorów z dawnego presetu (DPD 12:00, DPD Empik 12:00, Allegro 14:00, InPost 15:30, pon.–pt.). */
export const ACME_PICKUPS: PickupScheduleT[] = [
  { carrier: 'DPD', weekdays: [1, 2, 3, 4, 5], pickupMinute: 12 * 60, promiseUntilMinute: 11 * 60, active: true, example: false },
  { carrier: 'DPD_EMPIK', weekdays: [1, 2, 3, 4, 5], pickupMinute: 12 * 60, promiseUntilMinute: 11 * 60, active: true, example: false },
  { carrier: 'ALLEGRO', weekdays: [1, 2, 3, 4, 5], pickupMinute: 14 * 60, promiseUntilMinute: 13 * 60, active: true, example: false },
  { carrier: 'PACZKOMATY', weekdays: [1, 2, 3, 4, 5], pickupMinute: 15 * 60 + 30, promiseUntilMinute: 14 * 60 + 30, active: true, example: false },
]

/** Reguły stref z dawnego presetu: akcesoria najpierw, bo „lampa przyprawowa” to nie przyprawa. */
export const ACME_EXAMPLE_ZONE_RULES: ZoneRuleT[] = [
  { priority: 10, pattern: 'lamp|akcesori|zaparzacz|kubek|czajnik|filiżank|łyżeczk|puszk|sitk|termos', zone: 'BOMBY_AKCESORIA' },
  { priority: 20, pattern: 'przypraw|kaw[aiyę]|papryka|imbir|cynamon|napar|kurkuma|goździk|kardamon|curry', zone: 'HERBATY_KAWY' },
]

/** statusy ACME jak 22 statusy BL w 6 grupach + 2 bez grupy (kopia z seed/presety/acme.json, test równoważności w lib/preset-plik-nakladka.test.ts). */
export const ACME_STATUS_GROUPS: NonNullable<OrgPreset['statusGroups']> = [
  {
    key: 'DO_REALIZACJI',
    name: 'Do realizacji',
    sortOrder: 10,
    collapsed: false
  },
  {
    key: 'REALIZOWANE',
    name: 'Realizowane',
    sortOrder: 20,
    collapsed: false
  },
  {
    key: 'SPAKOWANE',
    name: 'Spakowane',
    sortOrder: 30,
    collapsed: false
  },
  {
    key: 'DO_WYSLANIA',
    name: 'Do wysłania',
    sortOrder: 40,
    collapsed: false
  },
  {
    key: 'ZAKONCZONE',
    name: 'Zakończone',
    sortOrder: 50,
    collapsed: true
  },
  {
    key: 'PROBLEMOWE',
    name: 'Problemowe',
    sortOrder: 60,
    collapsed: false
  }
]

export const ACME_STATUSES: NonNullable<OrgPreset['statuses']> = [
  { key: 'NOWE_ZAMOWIENIA', name: 'Nowe zamówienia', color: 'niebieski', groupKey: null, sortOrder: 10, baseStatus: 'NOWE', carriers: [], active: true },
  { key: 'EBOOK', name: 'E-book', color: 'fioletowy', groupKey: null, sortOrder: 20, baseStatus: 'DO_REALIZACJI', carriers: ['BEZ_WYSYLKI'], active: true },
  { key: 'DO_REALIZACJI_PACZKOMATY', name: 'Do realizacji Paczkomaty', color: 'pomaranczowy', groupKey: 'DO_REALIZACJI', sortOrder: 30, baseStatus: 'DO_REALIZACJI', carriers: ['PACZKOMATY', 'INPOST_KURIER'], active: true },
  { key: 'DO_REALIZACJI_DPD', name: 'Do realizacji DPD', color: 'pomaranczowy', groupKey: 'DO_REALIZACJI', sortOrder: 40, baseStatus: 'DO_REALIZACJI', carriers: ['DPD', 'DPD_EMPIK'], active: true },
  { key: 'DO_REALIZACJI_OSOBISTY', name: 'Do realizacji Osobisty', color: 'pomaranczowy', groupKey: 'DO_REALIZACJI', sortOrder: 50, baseStatus: 'DO_REALIZACJI', carriers: ['OSOBISTY'], active: true },
  { key: 'DO_REALIZACJI_ALLEGRO', name: 'Do realizacji Allegro', color: 'pomaranczowy', groupKey: 'DO_REALIZACJI', sortOrder: 60, baseStatus: 'DO_REALIZACJI', carriers: ['ALLEGRO'], active: true },
  { key: 'ROZPOCZETO_ZBIERANIE', name: 'Rozpoczęto zbieranie', color: 'szary', groupKey: 'REALIZOWANE', sortOrder: 70, baseStatus: 'ZBIERANIE', carriers: [], active: true },
  { key: 'ZEBRANE_PACZKOMATY', name: 'Zebrane Paczkomaty', color: 'szary', groupKey: 'REALIZOWANE', sortOrder: 80, baseStatus: 'ZEBRANE', carriers: ['PACZKOMATY', 'INPOST_KURIER'], active: true },
  { key: 'ZEBRANE_DPD', name: 'Zebrane DPD', color: 'szary', groupKey: 'REALIZOWANE', sortOrder: 90, baseStatus: 'ZEBRANE', carriers: ['DPD', 'DPD_EMPIK'], active: true },
  { key: 'ZEBRANE_OSOBISTY', name: 'Zebrane Osobisty', color: 'szary', groupKey: 'REALIZOWANE', sortOrder: 100, baseStatus: 'ZEBRANE', carriers: ['OSOBISTY'], active: true },
  { key: 'ZEBRANE_ALLEGRO', name: 'Zebrane Allegro', color: 'szary', groupKey: 'REALIZOWANE', sortOrder: 110, baseStatus: 'ZEBRANE', carriers: ['ALLEGRO'], active: true },
  { key: 'SPAKOWANE_PACZKOMATY', name: 'Spakowane Paczkomaty', color: 'turkusowy', groupKey: 'SPAKOWANE', sortOrder: 120, baseStatus: 'SPAKOWANE', carriers: ['PACZKOMATY', 'INPOST_KURIER'], active: true },
  { key: 'SPAKOWANE_DPD', name: 'Spakowane DPD', color: 'turkusowy', groupKey: 'SPAKOWANE', sortOrder: 130, baseStatus: 'SPAKOWANE', carriers: ['DPD', 'DPD_EMPIK'], active: true },
  { key: 'SPAKOWANE_OSOBISTY', name: 'Spakowane Osobisty', color: 'turkusowy', groupKey: 'SPAKOWANE', sortOrder: 140, baseStatus: 'SPAKOWANE', carriers: ['OSOBISTY'], active: true },
  { key: 'SPAKOWANE_ALLEGRO', name: 'Spakowane Allegro', color: 'turkusowy', groupKey: 'SPAKOWANE', sortOrder: 150, baseStatus: 'SPAKOWANE', carriers: ['ALLEGRO'], active: true },
  { key: 'DO_WYSLANIA', name: 'Do wysłania', color: 'zolty', groupKey: 'DO_WYSLANIA', sortOrder: 160, baseStatus: 'DO_WYSLANIA', carriers: [], active: true },
  { key: 'DO_ODBIORU', name: 'Do odbioru', color: 'zolty', groupKey: 'DO_WYSLANIA', sortOrder: 170, baseStatus: 'DO_ODBIORU', carriers: [], active: true },
  { key: 'ANULOWANE', name: 'Anulowane', color: 'czerwony', groupKey: 'ZAKONCZONE', sortOrder: 180, baseStatus: 'ANULOWANE', carriers: [], active: true },
  { key: 'WYSLANE', name: 'Wysłane', color: 'zielony', groupKey: 'ZAKONCZONE', sortOrder: 190, baseStatus: 'WYSLANE', carriers: [], active: true },
  { key: 'ODEBRANE', name: 'Odebrane', color: 'zielony', groupKey: 'ZAKONCZONE', sortOrder: 200, baseStatus: 'ODEBRANE', carriers: [], active: true },
  { key: 'DO_WYJASNIENIA', name: 'Do wyjaśnienia', color: 'rozowy', groupKey: 'PROBLEMOWE', sortOrder: 210, baseStatus: 'DO_WYJASNIENIA', carriers: [], active: true },
  { key: 'REKLAMACJA', name: 'Reklamacja', color: 'brazowy', groupKey: 'PROBLEMOWE', sortOrder: 220, baseStatus: 'REKLAMACJA', carriers: [], active: true },
]

export const ACME_PRESET: OrgPreset = {
  id: 'acme',
  slug: 'acme',
  name: 'ACME Group',
  settings: { baselinker: { inventoryId: '77701' }, catalog: { noStock: { skus: ['ebook1'] }, nonOfferSkus: ['naklejka', '80011', 'banderola-01', '80013', '80014'] }, faktury: { kodyVat: { '23': 222, '8': 223, '5': 224, '0': 234 } } },
  warehouses: [{ id: 'glowny', name: 'Główny (wFirma)', wfirmaWarehouseId: '900014' }],
  channels: ACME_CHANNELS.map(withAdapterSettings),
  carrierRules: ACME_CARRIER_RULES,
  carrierPickups: ACME_PICKUPS,
  zoneRules: ACME_EXAMPLE_ZONE_RULES,
  statusGroups: ACME_STATUS_GROUPS,
  statuses: ACME_STATUSES,
}
