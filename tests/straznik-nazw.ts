// Wspólne wzorce śladów konkretnych firm i wewnętrznej organizacji pracy dla strażnika publicznego wydania
// (tests/publiczne-wydanie.test.ts) i testów treści wbudowanych (szablony automatów). Jedyny plik w repo, który
// z założenia zawiera te nazwy; strażnik go pomija. Wielkość liter bez znaczenia, testy są w zakresie.

/** Słowa, których nie ma być w treściach wbudowanych (szablony automatów, przykłady): nazwy sklepów i ich asortymentu. */
export const NAZWY_FIRM_W_TRESCI = /kraina|herbat|bomb|etin|liveko|dpd_empik|baselinker/i

type Wzorzec = [kategoria: string, wzorzec: RegExp]

/** Ślady jednej firmy: [kategoria, wzorzec]. Strażnik szuka ich we wszystkich plikach tekstowych repo. */
export const ZAKAZANE: Wzorzec[] = [
  ['nazwa sklepu', /krainaherbaty|kraina herbaty|bombyherbaciane|bomby herbaciane|kolorowamatcha|kolorowa matcha/i],
  ['nazwa firmy', /etinbot|etingroup|(?<![a-z])etin(?![a-z])/i],
  ['asortyment firmy', /herbat|herbaci|izomalt|earl grey|(?<![a-z])(?:bomb(?:a|y|ę|ą|ie|ach|ami|om)?|matcha|sencha|rooibos|yerba|pu-?erh)(?![a-z])/i],
  ['skrót sklepu', /(?<![a-z0-9])kh(?![a-z])/i],
  ['katalog notatek', /materia[lł]y\//i],
  ['osoba z zespołu', /(?<![a-z])(?:kamil\w*|natali[ia]\w*|werwi[nń]sk\w*|matysik\w*|maciej\w*|damian\w*|majzner\w*|dagmar\w*|hryniewicz\w*)/i],
  ['ścieżka spoza repo', /C:\\+Asystent/i],
  ['adres wewnętrzny', /dewflow\.cloud/i],
  ['identyfikator konta', /(?<!\d)(?:4020996|4019593|4017634|40245)(?!\d)/],
]

/**
 * Wewnętrzne identyfikatory zadań i nazwy modeli z przeglądów: WŁĄCZONE po codemodzie identyfikatorów (komentarze,
 * tytuły testów i dokumentacja bez nich). Same wzorce sprawdza też test na przykładach.
 */
export const WLACZ_WZORCE_PRZED_PUBLIKACJA = true
export const WZORCE_PRZED_PUBLIKACJA: Wzorzec[] = [
  ['identyfikator zadania', /(?<![a-z])LOG-[AKD]-\d+/i],
  ['nazwa modelu', /(?<![a-z])(?:fable|opus|grok|sonnet|glm|qwen)(?![a-z])/i],
]

/**
 * Dozwolone fragmenty, wycinane przed sprawdzeniem (każdy z powodem):
 * - klucze danych dawnego enuma stref i stare adresy filtrów (zapisane w bazach firm, zmiana = migracja danych); nazwy
 *   stref z asortymentem firmy nie są wyjątkiem (należą do presetu firmy, w kodzie tylko neutralne);
 * - pojęcia techniczne („bomba ZIP”, „bomba pikseli”, „bomba dekompresyjna”);
 * - stary parametr adresu listy zamówień `kh` (zakładki i linki sprzed zmiany wyszukiwania; usunięcie psuje linki);
 * - identyfikatory i nazwy modeli dostawcy AI do wyboru w panelu (`claude-opus-…`, „Claude Sonnet 5.5”): to funkcja
 *   produktu (lib/ai.ts), nie ślad przeglądu kodu.
 */
export const DOZWOLONE_FRAGMENTY: RegExp[] = [
  /\{ herbaty: 'HERBATY_KAWY', bomby: 'BOMBY_AKCESORIA' \}/g,
  /HERBATY_KAWY|BOMBY_AKCESORIA/gi,
  /strefa=(?:herbaty|bomby)/g,
  /parseZoneFilter\('(?:herbaty|bomby)'/g,
  /zone: '(?:herbaty|bomby)'/g,
  /„herbaty” nic nie znaczy|\(herbaty, bomby\)/g,
  /bomb\S* (?:ZIP|pikseli|dekompres\S*)|ZIP[- ]bomb\S*/gi,
  /`kh`|\bsp\.kh\b|\bkh: (?:parametry\('kh'\)|undefined)/g,
  /\bclaude-(?:opus|sonnet)-\d[\w.-]*/g,
  /\bClaude (?:Opus|Sonnet) \d+(?:\.\d+)?/g,
]

/**
 * Pliki pominięte w całości (jawna lista, każdy z powodem):
 * - ten plik: definiuje wzorce; test strażnika sprawdza je na przykładach z nazwami;
 * - testy presetu prywatnej firmy: biegną tylko z nakładką prywatne/ (sekret CI, `skipIf` bez niej), nazwy wynikają
 *   z treści presetu;
 * - testy migracji z danymi pierwszej firmy: migracje to historia, decyzja o migracji bazowej przed publikacją;
 * - krok CI rozpakowujący nakładkę wymienia testy presetu z nazwy.
 */
export const PLIKI_POZA_STRAZNIKIEM = new Set([
  'tests/straznik-nazw.ts',
  'tests/publiczne-wydanie.test.ts',
])

/** Pliki poza zakresem z natury: historia migracji, binaria, schematy MF (kody krajów: KH = Kambodża), lock zależności. */
export const pozaZakresem = (f: string): boolean =>
  f.startsWith('prisma/migrations/') ||
  f === 'package-lock.json' ||
  /\.(png|jpe?g|gif|ico|pdf|ttf|otf|woff2?|webp|zip|xsd)$/i.test(f)

/** Nazwa firmy-właściciela praw (pełna nazwa spółki i adres kontaktowy) tylko w plikach projektu: licencja, README, zasady wkładu, umowa wkładu (CLA), kontakt. */
export const NAZWA_WLASCICIELA_DOZWOLONA = new Set(['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CLA.md', 'package.json'])
const NAZWA_WLASCICIELA = /ETIN Group Sp\. z o\.o\.|kontakt@etin\.pl/g

/** Aktywne wzorce: stałe ślady firmy, a po włączeniu także identyfikatory zadań i nazwy modeli. */
export const wzorceAktywne = (wlaczPrzedPublikacja = WLACZ_WZORCE_PRZED_PUBLIKACJA): Wzorzec[] =>
  wlaczPrzedPublikacja ? [...ZAKAZANE, ...WZORCE_PRZED_PUBLIKACJA] : ZAKAZANE

/** Trafienia w jednym pliku: „plik:linia: kategoria” (bez treści linii, żeby raport nie powielał danych). */
export function slady(plik: string, tresc: string, wzorce: Wzorzec[] = wzorceAktywne()): string[] {
  const wynik: string[] = []
  tresc.split(/\r?\n/).forEach((linia, i) => {
    let czysta = linia
    for (const d of DOZWOLONE_FRAGMENTY) czysta = czysta.replace(d, ' ')
    if (NAZWA_WLASCICIELA_DOZWOLONA.has(plik)) czysta = czysta.replace(NAZWA_WLASCICIELA, ' ')
    for (const [kategoria, re] of wzorce) {
      if (re.test(czysta)) wynik.push(`${plik}:${i + 1}: ${kategoria}`)
    }
  })
  return wynik
}
