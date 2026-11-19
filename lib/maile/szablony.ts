// Szablony domyślne (zastępują szablony z BaseLinkera). Ton: uprzejmie i krótko, „Dzień dobry” (z imieniem,
// jeśli jest), bez długich myślników i bez nadmiaru wykrzykników (pilnują tego testy). Treść per firma/sklep
// można nadpisać (NadpisanieSzablonu); zmienne każdego szablonu są zadeklarowane tutaj.
import type { Blok, DefinicjaSzablonu, RodzajMaila } from './typy'

const POWITANIE: Blok = { typ: 'akapit', tekst: 'Dzień dobry{{#imie}} {{imie}}{{/imie}},' }
const PODPIS: Blok = { typ: 'akapit', tekst: 'Pozdrawiamy\nZespół sklepu {{sklep.nazwa}}' }
const IMIE = { opis: 'imię klienta (powitanie)', wymagana: false }
const NUMER_ZAMOWIENIA = { opis: 'numer zamówienia', wymagana: true }
const POZYCJE = { opis: 'pozycje zamówienia, np. „2 × Kubek ceramiczny”', wymagana: false, lista: true }
const ZWROCONE = { opis: 'zwrócone produkty, np. „1 × Kubek ceramiczny”', wymagana: false, lista: true }

/** Po ilu dniach roboczych od złożenia wysyłamy przypomnienie o płatności (planuje to wysyłka, nie szablon). */
export const PRZYPOMNIENIE_O_PLATNOSCI_PO_DNIACH_ROBOCZYCH = 2

export const SZABLONY_DOMYSLNE: Record<RodzajMaila, DefinicjaSzablonu> = {
  'brak-platnosci': {
    rodzaj: 'brak-platnosci',
    odbiorca: 'klient',
    zmienne: {
      imie: IMIE,
      numerZamowienia: NUMER_ZAMOWIENIA,
      kwota: { opis: 'kwota do zapłaty, sformatowana', wymagana: true },
      linkPlatnosci: { opis: 'link do płatności online', wymagana: false },
      dniDoAnulowania: { opis: 'np. „5 dni roboczych” (w sezonie krócej)', wymagana: true },
      terminAnulowania: { opis: 'data anulowania, np. „30 października 2026”', wymagana: false },
      pozycje: POZYCJE,
    },
    temat: 'Przypomnienie o płatności za zamówienie {{numerZamowienia}}',
    podglad: 'Czekamy na płatność {{kwota}} za zamówienie {{numerZamowienia}}.',
    naglowek: 'Czekamy na płatność',
    bloki: [
      POWITANIE,
      {
        typ: 'akapit',
        tekst: 'dziękujemy za zamówienie w sklepie {{sklep.nazwa}}. Nie widzimy jeszcze płatności, dlatego uprzejmie o niej przypominamy.',
      },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Numer zamówienia', wartosc: '{{numerZamowienia}}' },
          { etykieta: 'Kwota do zapłaty', wartosc: '{{kwota}}' },
        ],
      },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Zamówione produkty', jesli: 'pozycje' },
      { typ: 'przycisk', etykieta: 'Zapłać za zamówienie', url: '{{linkPlatnosci}}', jesli: 'linkPlatnosci' },
      {
        typ: 'akapit',
        tekst: '{{^linkPlatnosci}}Płatności można dokonać w sposób wybrany przy składaniu zamówienia.{{/linkPlatnosci}}',
      },
      {
        typ: 'uwaga',
        // Z datą: „do <data>” (prawdziwe w dniu wysyłki także w sezonie). Bez daty: „w ciągu N dni roboczych”.
        tekst:
          '{{#terminAnulowania}}Jeśli płatność nie wpłynie do {{terminAnulowania}}, zamówienie zostanie anulowane.{{/terminAnulowania}}' +
          '{{^terminAnulowania}}Jeśli płatność nie wpłynie w ciągu {{dniDoAnulowania}} od złożenia zamówienia, zamówienie zostanie anulowane.{{/terminAnulowania}}',
      },
      {
        typ: 'akapit',
        tekst: 'Jeśli płatność została już wysłana, prosimy zignorować tę wiadomość. W razie pytań wystarczy odpowiedzieć na ten e-mail.',
      },
      PODPIS,
    ],
  },

  // Po nieudanej płatności online (bramka odrzuciła płatność): zamiast zwykłego przypomnienia, zwykle następnego dnia.
  // Układ i ton jak „Brak płatności”; inne jest tylko to, co musi: pytanie o problem, dane do przelewu, stan towaru.
  'nieudana-platnosc': {
    rodzaj: 'nieudana-platnosc',
    odbiorca: 'klient',
    zmienne: {
      imie: IMIE,
      numerZamowienia: NUMER_ZAMOWIENIA,
      kwota: { opis: 'kwota do zapłaty, sformatowana', wymagana: true },
      odbiorcaPrzelewu: { opis: 'odbiorca przelewu (nazwa firmy z Danych firmy)', wymagana: true },
      rachunek: { opis: 'numer rachunku firmy do przelewu', wymagana: true },
      tytulPrzelewu: { opis: 'tytuł przelewu z numerem zamówienia, jaki klient zna ze sklepu (bez przedrostka konta), np. „Zamówienie 2026-00123”', wymagana: true },
      terminAnulowania: { opis: 'data anulowania, np. „20 listopada 2026”', wymagana: true },
      towarZwolniony: { opis: 'jest, gdy towar nie jest już zarezerwowany (krótki termin po nieudanej płatności minął)', wymagana: false },
      pozycje: POZYCJE,
    },
    temat: 'Czy był problem z płatnością za zamówienie {{numerZamowienia}}?',
    podglad: 'Płatność online za zamówienie {{numerZamowienia}} nie doszła do skutku. Poniżej dane do przelewu.',
    naglowek: 'Czy był problem z płatnością?',
    bloki: [
      POWITANIE,
      {
        typ: 'akapit',
        tekst:
          'dziękujemy za zamówienie w sklepie {{sklep.nazwa}}. Płatność online za to zamówienie nie doszła do skutku. Czy wystąpił jakiś problem z płatnością? Zamówienie nadal czeka na wpłatę.',
      },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Numer zamówienia', wartosc: '{{numerZamowienia}}' },
          { etykieta: 'Kwota do zapłaty', wartosc: '{{kwota}}' },
        ],
      },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Zamówione produkty', jesli: 'pozycje' },
      { typ: 'akapit', tekst: 'Zamiast płatności online można zapłacić zwykłym przelewem:' },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Odbiorca', wartosc: '{{odbiorcaPrzelewu}}' },
          { etykieta: 'Numer rachunku', wartosc: '{{rachunek}}' },
          { etykieta: 'Kwota', wartosc: '{{kwota}}' },
          { etykieta: 'Tytuł przelewu', wartosc: '{{tytulPrzelewu}}' },
        ],
      },
      {
        typ: 'akapit',
        jesli: 'towarZwolniony',
        tekst: 'Do czasu wpłaty towar z tego zamówienia nie jest już dla Państwa zarezerwowany. Po wpłacie zrealizujemy zamówienie z produktów, które będą wtedy dostępne.',
      },
      { typ: 'uwaga', tekst: 'Jeśli płatność nie wpłynie do {{terminAnulowania}}, zamówienie zostanie anulowane.' },
      {
        typ: 'akapit',
        tekst: 'Jeśli płatność została już wysłana, prosimy zignorować tę wiadomość. W razie pytań albo problemu z płatnością wystarczy odpowiedzieć na ten e-mail.',
      },
      PODPIS,
    ],
  },

  faktura: {
    rodzaj: 'faktura',
    odbiorca: 'klient',
    zmienne: {
      imie: IMIE,
      // bez numeru z programu do faktur mail wychodzi bez numeru (sekcje niżej), nigdy z identyfikatorem dokumentu
      numerFaktury: { opis: 'numer faktury (bywa pusty, gdy program do faktur go nie podał: używaj w {{#numerFaktury}}…{{/numerFaktury}})', wymagana: false },
      numerZamowienia: NUMER_ZAMOWIENIA,
      numerPrzesylki: { opis: 'numer przesyłki (pusty, gdy zamówienie nie ma przesyłki: używaj z warunkiem)', wymagana: false },
      linkSledzenia: { opis: 'link do śledzenia przesyłki na stronie przewoźnika (bywa pusty)', wymagana: false },
    },
    temat: 'Faktura{{#numerFaktury}} {{numerFaktury}}{{/numerFaktury}} do zamówienia {{numerZamowienia}}',
    podglad: 'W załączniku przesyłamy fakturę{{#numerFaktury}} {{numerFaktury}}{{/numerFaktury}}{{^numerFaktury}} do zamówienia {{numerZamowienia}}{{/numerFaktury}}.',
    naglowek: 'Faktura do zamówienia',
    bloki: [
      POWITANIE,
      { typ: 'akapit', tekst: 'w załączniku przesyłamy fakturę do zamówienia złożonego w sklepie {{sklep.nazwa}}.' },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Numer faktury', wartosc: '{{numerFaktury}}', jesli: 'numerFaktury' },
          { etykieta: 'Numer zamówienia', wartosc: '{{numerZamowienia}}' },
          { etykieta: 'Numer przesyłki', wartosc: '{{numerPrzesylki}}', jesli: 'numerPrzesylki' },
        ],
      },
      // mail wychodzi przy „Wysłane”/„Odebrane”, ale „Wysłane” bywa ustawione przed odbiorem paczki przez
      // kuriera (kliknięcie, śledzenie, punkt cięcia), więc tekst nie twierdzi, że paczka już jedzie
      { typ: 'akapit', tekst: 'Paczka jest spakowana. Po odbiorze przez kuriera jej drogę można sprawdzić na stronie przewoźnika.', jesli: 'linkSledzenia' },
      { typ: 'przycisk', etykieta: 'Śledź przesyłkę', url: '{{linkSledzenia}}', jesli: 'linkSledzenia' },
      { typ: 'akapit', tekst: 'Faktura jest w pliku PDF dołączonym do tej wiadomości. W razie pytań wystarczy odpowiedzieć na ten e-mail.' },
      { typ: 'akapit', tekst: 'Dziękujemy za zakupy.' },
      PODPIS,
    ],
  },

  'gotowe-do-odbioru': {
    rodzaj: 'gotowe-do-odbioru',
    odbiorca: 'klient',
    zmienne: {
      imie: IMIE,
      numerZamowienia: NUMER_ZAMOWIENIA,
      adresOdbioru: { opis: 'linie adresu punktu odbioru (dane sklepu)', wymagana: true, lista: true },
      godzinyOdbioru: { opis: 'godziny otwarcia punktu odbioru (dane sklepu)', wymagana: true, lista: true },
      uwagiOdbioru: { opis: 'dodatkowe informacje sklepu o odbiorze', wymagana: false },
      odbiorDo: { opis: 'do kiedy zamówienie czeka, np. „30 października 2026”', wymagana: false },
      pozycje: POZYCJE,
    },
    temat: 'Zamówienie {{numerZamowienia}} czeka na odbiór',
    podglad: 'Zamówienie {{numerZamowienia}} jest gotowe do odbioru osobistego.',
    naglowek: 'Zamówienie gotowe do odbioru',
    bloki: [
      POWITANIE,
      { typ: 'akapit', tekst: 'zamówienie {{numerZamowienia}} jest już gotowe do odbioru osobistego.' },
      { typ: 'lista', zmienna: 'adresOdbioru', naglowek: 'Adres odbioru' },
      { typ: 'lista', zmienna: 'godzinyOdbioru', naglowek: 'Godziny odbioru' },
      { typ: 'akapit', tekst: '{{uwagiOdbioru}}', jesli: 'uwagiOdbioru' },
      { typ: 'uwaga', tekst: 'Zamówienie czeka na odbiór do {{odbiorDo}}.', jesli: 'odbiorDo' },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Zamówione produkty', jesli: 'pozycje' },
      { typ: 'akapit', tekst: 'Przy odbiorze prosimy podać numer zamówienia.' },
      PODPIS,
    ],
  },

  'blad-faktury': {
    rodzaj: 'blad-faktury',
    odbiorca: 'biuro',
    zmienne: {
      numerZamowienia: NUMER_ZAMOWIENIA,
      trescBledu: { opis: 'treść błędu z systemu faktur', wymagana: true },
      // bez PANEL_URL instancji linku nie ma, a mail i tak ma dojść (przycisk znika)
      linkDoZamowienia: { opis: 'link do zamówienia w panelu', wymagana: false },
      kiedy: { opis: 'data i godzina błędu', wymagana: false },
    },
    temat: 'Błąd wystawiania faktury: zamówienie {{numerZamowienia}} ({{sklep.nazwa}})',
    podglad: 'Faktura do zamówienia {{numerZamowienia}} nie została wystawiona.',
    naglowek: 'Nie udało się wystawić faktury',
    bloki: [
      { typ: 'akapit', tekst: 'Dzień dobry,' },
      {
        typ: 'akapit',
        tekst: 'faktura do zamówienia {{numerZamowienia}} ze sklepu {{sklep.nazwa}} nie została wystawiona. Zamówienie wymaga sprawdzenia w panelu.',
      },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Numer zamówienia', wartosc: '{{numerZamowienia}}' },
          { etykieta: 'Sklep', wartosc: '{{sklep.nazwa}}' },
          { etykieta: 'Kiedy', wartosc: '{{kiedy}}', jesli: 'kiedy' },
        ],
      },
      { typ: 'akapit', tekst: 'Treść błędu:' },
      { typ: 'kod', tekst: '{{trescBledu}}' },
      { typ: 'przycisk', etykieta: 'Otwórz zamówienie w panelu', url: '{{linkDoZamowienia}}', jesli: 'linkDoZamowienia' },
      { typ: 'akapit', tekst: 'Wiadomość wysłana automatycznie przez Kompletor. Klient nie dostał tej wiadomości.' },
    ],
  },

  // niski stan (reguła P2 planu akcji, w BL szablon „Kategorie”), do biura firmy
  'niski-stan': {
    rodzaj: 'niski-stan',
    odbiorca: 'biuro',
    zmienne: {
      sku: { opis: 'kod produktu (SKU)', wymagana: true },
      nazwaProduktu: { opis: 'nazwa produktu', wymagana: false },
      dostepne: { opis: 'ile sztuk jest dostępnych', wymagana: true },
      prog: { opis: 'próg niskiego stanu produktu', wymagana: true },
      linkDoProduktu: { opis: 'link do produktu w panelu', wymagana: false },
    },
    temat: 'Niski stan: {{sku}}{{#nazwaProduktu}} {{nazwaProduktu}}{{/nazwaProduktu}}',
    podglad: 'Dostępne {{dostepne}} szt. przy progu {{prog}} szt.',
    naglowek: 'Kończy się towar',
    bloki: [
      { typ: 'akapit', tekst: 'Dzień dobry,' },
      { typ: 'akapit', tekst: 'stan produktu spadł poniżej progu ustawionego w Kompletorze. Warto zamówić towar.' },
      {
        typ: 'szczegoly',
        wiersze: [
          { etykieta: 'Produkt', wartosc: '{{nazwaProduktu}}', jesli: 'nazwaProduktu' },
          { etykieta: 'SKU', wartosc: '{{sku}}' },
          { etykieta: 'Dostępne', wartosc: '{{dostepne}} szt.' },
          { etykieta: 'Próg', wartosc: '{{prog}} szt.' },
        ],
      },
      { typ: 'przycisk', etykieta: 'Otwórz produkt w panelu', url: '{{linkDoProduktu}}', jesli: 'linkDoProduktu' },
      { typ: 'akapit', tekst: 'Wiadomość wysłana automatycznie przez Kompletor. Kolejna przyjdzie dopiero, gdy stan wróci powyżej progu i znów spadnie.' },
    ],
  },

  // reset hasła do panelu (osoba z kontem, nie klient sklepu)
  'reset-hasla': {
    rodzaj: 'reset-hasla',
    odbiorca: 'biuro',
    zmienne: {
      link: { opis: 'jednorazowy link do ustawienia nowego hasła', wymagana: true },
      waznyDo: { opis: 'do kiedy link działa', wymagana: true },
    },
    temat: 'Ustawienie nowego hasła do Kompletora ({{firma.nazwa}})',
    podglad: 'Link do ustawienia nowego hasła działa do {{waznyDo}}.',
    naglowek: 'Nowe hasło do panelu',
    bloki: [
      { typ: 'akapit', tekst: 'Dzień dobry,' },
      { typ: 'akapit', tekst: 'ktoś poprosił o ustawienie nowego hasła do konta w Kompletorze dla tego adresu e-mail. Jeśli to Ty, kliknij przycisk poniżej.' },
      { typ: 'przycisk', etykieta: 'Ustaw nowe hasło', url: '{{link}}' },
      { typ: 'uwaga', tekst: 'Link działa jeden raz, do {{waznyDo}}.' },
      { typ: 'akapit', tekst: 'Jeśli to nie Ty, zignoruj tę wiadomość: hasło się nie zmieni.' },
    ],
  },

  // zaproszenie do firmy w panelu (osoba bez dostępu do tej firmy, nie klient sklepu)
  zaproszenie: {
    rodzaj: 'zaproszenie',
    odbiorca: 'biuro',
    zmienne: {
      link: { opis: 'link do przyjęcia zaproszenia', wymagana: true },
      rola: { opis: 'rola w firmie, np. Magazyn', wymagana: true },
      waznyDo: { opis: 'do kiedy link działa', wymagana: true },
    },
    temat: 'Zaproszenie do firmy {{firma.nazwa}} w Kompletorze',
    podglad: 'Link do przyjęcia zaproszenia działa do {{waznyDo}}.',
    naglowek: 'Zaproszenie do panelu',
    bloki: [
      { typ: 'akapit', tekst: 'Dzień dobry,' },
      { typ: 'akapit', tekst: 'firma {{firma.nazwa}} zaprasza Cię do pracy w Kompletorze (rola: {{rola}}). Kliknij przycisk, żeby przyjąć zaproszenie: zalogujesz się istniejącym kontem albo założysz nowe z własnym hasłem.' },
      { typ: 'przycisk', etykieta: 'Przyjmij zaproszenie', url: '{{link}}' },
      { typ: 'uwaga', tekst: 'Link działa do {{waznyDo}} i tylko dla tego adresu e-mail.' },
      { typ: 'akapit', tekst: 'Jeśli nie spodziewasz się tego zaproszenia, zignoruj tę wiadomość: bez kliknięcia nic się nie stanie.' },
    ],
  },

  // Zwroty i reklamacje (do klienta, za wyłącznikiem firmy): bez kwot, terminów i obietnic, których system nie pilnuje
  'zwrot-przyjety': {
    rodzaj: 'zwrot-przyjety',
    odbiorca: 'klient',
    zmienne: { imie: IMIE, numerZamowienia: NUMER_ZAMOWIENIA, pozycje: ZWROCONE },
    temat: 'Zwrot do zamówienia {{numerZamowienia}} dotarł do nas',
    podglad: 'Paczka ze zwrotem do zamówienia {{numerZamowienia}} jest już u nas.',
    naglowek: 'Zwrot dotarł do nas',
    bloki: [
      POWITANIE,
      { typ: 'akapit', tekst: 'paczka ze zwrotem do zamówienia {{numerZamowienia}} ze sklepu {{sklep.nazwa}} dotarła do nas.' },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Zwrócone produkty', jesli: 'pozycje' },
      { typ: 'akapit', tekst: 'Teraz sprawdzimy zwrócone produkty i damy znać, co dalej.' },
      { typ: 'akapit', tekst: 'W razie pytań wystarczy odpowiedzieć na tę wiadomość.' },
      PODPIS,
    ],
  },

  'reklamacja-przyjeta': {
    rodzaj: 'reklamacja-przyjeta',
    odbiorca: 'klient',
    zmienne: { imie: IMIE, numerZamowienia: NUMER_ZAMOWIENIA, pozycje: ZWROCONE },
    temat: 'Reklamacja do zamówienia {{numerZamowienia}} dotarła do nas',
    podglad: 'Reklamowany produkt z zamówienia {{numerZamowienia}} jest już u nas.',
    naglowek: 'Reklamacja dotarła do nas',
    bloki: [
      POWITANIE,
      { typ: 'akapit', tekst: 'paczka z reklamowanym produktem z zamówienia {{numerZamowienia}} ze sklepu {{sklep.nazwa}} dotarła do nas.' },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Reklamowane produkty', jesli: 'pozycje' },
      { typ: 'akapit', tekst: 'Teraz rozpatrzymy reklamację i poinformujemy o decyzji.' },
      { typ: 'akapit', tekst: 'W razie pytań wystarczy odpowiedzieć na tę wiadomość.' },
      PODPIS,
    ],
  },

  'zwrot-pieniedzy': {
    rodzaj: 'zwrot-pieniedzy',
    odbiorca: 'klient',
    zmienne: { imie: IMIE, numerZamowienia: NUMER_ZAMOWIENIA, pozycje: ZWROCONE },
    temat: 'Zwrot pieniędzy za zamówienie {{numerZamowienia}}',
    podglad: 'Zwróciliśmy pieniądze za zwrócone produkty z zamówienia {{numerZamowienia}}.',
    naglowek: 'Pieniądze zwrócone',
    bloki: [
      POWITANIE,
      { typ: 'akapit', tekst: 'zwróciliśmy pieniądze za zwrócone produkty z zamówienia {{numerZamowienia}} ze sklepu {{sklep.nazwa}}.' },
      { typ: 'lista', zmienna: 'pozycje', naglowek: 'Produkty', jesli: 'pozycje' },
      { typ: 'akapit', tekst: 'Czas, po którym pieniądze pojawią się na koncie, zależy od banku albo operatora płatności.' },
      { typ: 'akapit', tekst: 'W razie pytań wystarczy odpowiedzieć na tę wiadomość.' },
      PODPIS,
    ],
  },
}
