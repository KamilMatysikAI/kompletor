# Agenci AI: podłącz asystenta do Kompletora

Asystent AI (np. Claude Code, Cursor albo Copilot w VS Code) może sprawdzać w Kompletorze zamówienia, stany, produkty,
braki, liczby dnia i sprzedaż (okresy, kanały, produkty, marża). Pytasz go zwykłym językiem, a on sam zagląda do Kompletora.

**Asystent tylko czyta.** Niczego nie zmienia, niczego nie wysyła do sklepów ani przewoźników i nie widzi danych
klientów (imion, adresów, telefonów, e-maili).

Gdzie: **Panel → Ustawienia → Integracje i agenci AI → Agenci AI** (`/ustawienia/agenci-ai`). Ekran widzi osoba z uprawnieniem „Ustawienia
firmy”.

## Dostawca AI (opisy i packshoty)

Na tym samym ekranie, w sekcji **„Dostawca AI”**, właściciel wpisuje klucz API Anthropic (podpowiedź opisu produktu),
wybiera model i wpisuje klucz Kie.ai (packshot, czyli zdjęcie produktu na białym tle). Pole **„Packshot AI włączony”**
pokazuje przycisk „Packshot (AI)” przy zdjęciach na karcie produktu. Klucze zapisują się zaszyfrowane; ekran pokazuje
tylko, skąd jest klucz („zapisany w firmie”, „z ustawień serwera”). Puste pole klucza przy zapisie = klucz bez zmian.
Przyciski „Usuń klucz …” usuwają klucz firmy (np. po wycieku). To nie dotyczy agentów: agent podłączony niżej działa
bez tych kluczy.

Packshot jest płatny po stronie Kie.ai, więc Kompletor zleca go dokładnie raz na kliknięcie: gdy Kie.ai nie skończy
w ok. 3 minuty, system sprawdzi wynik tego samego zlecenia jeszcze raz (bez nowej opłaty), a potem zapisze w historii
produktu „Kie.ai nie skończył packshotu w wyznaczonym czasie” i można kliknąć ponownie. Koszt zapisuje się zaraz po
zleceniu, także gdy wynik nie dojdzie. W hostingu, gdy firma nie ma własnego klucza i korzysta z klucza Kompletora,
obowiązuje dobowy limit AI na firmę (domyślnie 20 zł na 24 godziny, zmienna `PLATFORM_AI_LIMIT_DZIENNY_GROSZE`);
po jego wyczerpaniu przyciski opisu i packshotu mówią, ile wykorzystano, i podpowiadają własny klucz.

## Asystent „Zapytaj” (pytania o obsługę panelu)

Asystent odpowiada na pytania o to, jak pracować w Kompletorze, np. „jak zrobić korektę faktury?” albo „co znaczy
Do wyjaśnienia?”. Odpowiedź bierze **wyłącznie z Pomocy** i zawsze podaje rozdział, z którego pochodzi (odnośnik pod
odpowiedzią). Gdy Pomoc nie ma odpowiedzi, asystent pisze „Nie wiem, gdzie to jest” i podsuwa spis Pomocy, zamiast
zgadywać.

- **Gdzie jest:** przycisk **„Zapytaj”** w prawym dolnym rogu każdego ekranu panelu (gdy na dole ekranu jest pasek
  „Zapisz zmiany”, przycisk siedzi nad nim). W okienku jest też odnośnik **„Pomoc do tego ekranu”**.
- **Kto widzi:** każda osoba z dostępem do panelu (uprawnienie „Podgląd panelu”), gdy asystent jest włączony.
- **Jak włączyć:** właściciel w **Ustawienia → Integracje i agenci AI → Agenci AI**, sekcja **„Dostawca AI i asystent”**,
  pole **„Asystent »Zapytaj« włączony”** i **Zapisz**. Asystent korzysta z tego samego klucza Anthropic i modelu co
  podpowiedź opisu. Domyślnie jest wyłączony; po wyłączeniu przycisk znika z panelu. Bez klucza Anthropic przycisk
  się nie pokazuje, nawet gdy asystent jest włączony.
- **Co trafia do AI:** tylko treść pytania (adresy e-mail, telefony, numery kont i kody pocztowe zamieniamy na
  znaczniki) i wybrane fragmenty Pomocy. Asystent nie widzi zamówień, produktów, stanów ani danych klientów i niczego
  nie zmienia. Pytanie o konkretne zamówienie dostanie odpowiedź, gdzie w panelu to sprawdzić.
- **Koszt:** pytanie, na które Pomoc nie ma żadnego fragmentu, nie idzie do AI (0 zł). Pozostałe zapisują się w
  zużyciu AI firmy jak podpowiedź opisu (przy kluczu Kompletora w hostingu z dobowym limitem opisanym wyżej).
- **Limity pytań:** jedna osoba najwyżej 6 pytań na minutę i 100 na dobę, cała firma najwyżej 30 pytań na minutę
  i 500 odpowiedzi z AI na dobę (na własnym serwerze zmienna `ASYSTENT_PYTANIA_FIRMY_NA_DOBE`, 0 = asystent odpowiada
  tylko „nie wiem”). Po przekroczeniu asystent pisze, za ile spróbować ponownie.

## Podłącz agenta krok po kroku

1. Wejdź w **Ustawienia → Integracje i agenci AI → Agenci AI**.
2. Na górze jest **adres serwera MCP** tej instalacji, np. `https://kompletor.example.invalid/api/mcp`.
3. W części **Nowy klucz agenta** wpisz nazwę, po której rozpoznasz klucz (np. „Claude Code, Anna”), i kliknij
   **Utwórz klucz agenta**. Klucz ma zakres „tylko odczyt”.
4. **Pełny klucz widać tylko raz.** Od razu pod nim są gotowe fragmenty konfiguracji z wpisanym kluczem: skopiuj ten
   dla swojego programu. Po odświeżeniu strony zostaje sam początek klucza.
5. Wklej fragment w programie (niżej, jak dla którego) i zapytaj asystenta, np. „ile zostało TEST-PRZYPRAWA?”.
6. Na dole ekranu, w **Ostatnie wywołania**, widać, co asystent sprawdzał (nazwa narzędzia, wynik, czas, klucz),
   bez treści pytań i odpowiedzi.

Klucz, który wyciekł albo nie jest potrzebny, odwołujesz w **Ustawienia → Integracje i agenci AI → Klucze API** (przycisk „Odwołaj”). Osobny
klucz dla każdej osoby i każdego programu: wtedy odwołanie jednego nie odcina pozostałych.

## Konfiguracja programów

W przykładach adres `https://kompletor.example.invalid` i klucz `kmp_PRZYKLADOWY_KLUCZ`; u siebie wpisz swój adres
i swój klucz (ekran podaje gotowe fragmenty).

### Claude Code

W terminalu:

```bash
claude mcp add --transport http kompletor https://kompletor.example.invalid/api/mcp --header "Authorization: Bearer kmp_PRZYKLADOWY_KLUCZ"
```

Sprawdzenie: `claude mcp list`, a w rozmowie `/mcp`.

### Cursor

Plik `~/.cursor/mcp.json` (albo `.cursor/mcp.json` w projekcie):

```json
{
  "mcpServers": {
    "kompletor": {
      "url": "https://kompletor.example.invalid/api/mcp",
      "headers": { "Authorization": "Bearer kmp_PRZYKLADOWY_KLUCZ" }
    }
  }
}
```

### VS Code (GitHub Copilot)

Plik `.vscode/mcp.json` w projekcie. VS Code zapyta o klucz raz i przechowa go bezpiecznie (klucza nie ma w pliku):

```json
{
  "inputs": [{ "type": "promptString", "id": "kompletor-klucz", "description": "Klucz agenta Kompletora (kmp_…)", "password": true }],
  "servers": {
    "kompletor": {
      "type": "http",
      "url": "https://kompletor.example.invalid/api/mcp",
      "headers": { "Authorization": "Bearer ${input:kompletor-klucz}" }
    }
  }
}
```

### Gemini CLI

Plik `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "kompletor": {
      "httpUrl": "https://kompletor.example.invalid/api/mcp",
      "headers": { "Authorization": "Bearer kmp_PRZYKLADOWY_KLUCZ" }
    }
  }
}
```

### Claude Desktop

Łącznik zdalny w Claude Desktop i na claude.ai (Ustawienia → Łączniki) wymaga logowania OAuth, którego Kompletor
jeszcze nie ma. Do tego czasu działa **pomost** `kompletor-mcp`: potrzebny Node.js i plik `kompletor-mcp.cjs`
z instalacji Kompletora (poproś obsługę instalacji). Plik powstaje w obrazie Dockera instalacji własnej (self-host),
więc trzeba go skopiować z kontenera na komputer z Claude Desktop. W hostingu Kompletora pliku do pobrania jeszcze nie
ma: Claude Desktop podłączysz razem z OAuth (tak jak ChatGPT). W Claude Desktop: Ustawienia → Programista → Edytuj
konfigurację, plik `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kompletor": {
      "command": "node",
      "args": ["/sciezka/do/kompletor-mcp.cjs"],
      "env": {
        "KOMPLETOR_URL": "https://kompletor.example.invalid",
        "KOMPLETOR_API_KEY": "kmp_PRZYKLADOWY_KLUCZ"
      }
    }
  }
}
```

Po zapisaniu uruchom Claude Desktop ponownie.

### ChatGPT

Łączniki ChatGPT przyjmują serwer bez logowania albo z logowaniem OAuth, nie z kluczem. **Wkrótce**: po dodaniu
OAuth do Kompletora.

## Przykładowe polecenia

- „Pokaż nieopłacone zamówienia z wczoraj.”
- „Ile zostało TEST-PRZYPRAWA?”
- „Co z zamówieniem TEST-0001? Czy już wysłane i z jakim numerem nadania?”
- „Czego brakuje do zamówień i które zamówienia czekają na towar?”
- „Kto trzyma rezerwację na TEST-KUBEK?”
- „Z czego składa się TEST-ZESTAW i na jakich kanałach go wystawiamy?”
- „Jak idzie dzisiaj? Ile mamy do spakowania?”
- „Ile sprzedaliśmy w październiku w porównaniu z wrześniem i który kanał urósł?”
- „Które produkty mają najwyższą marżę w tym miesiącu, a którym brakuje ceny zakupu?”
- „Co znaczy status »Do wyjaśnienia«?”

## Czego agent nie zrobi i dlaczego

- **Nie poda danych klientów** (imion, adresów, telefonów, e-maili, NIP-u, treści wiadomości). Dane klientów nie
  trafiają do AI bez osobnej decyzji właściciela, bo asystent działa u dostawcy AI, poza Kompletorem.
- **Niczego nie zmieni**: nie zmieni statusu, nie anuluje, nie przygotuje przesyłki ani faktury. Przygotowanie
  przesyłek i faktur (z potwierdzeniem przed wykonaniem) dojdzie w osobnym zadaniu, z osobnym zakresem klucza.
- **Nie wyśle niczego** do sklepów, Allegro, przewoźników, wFirmy ani KSeF.
- **Widzi tylko Twoją firmę**: klucz należy do jednej firmy, innej nie da się wskazać.
- **Ma limity**: 60 sprawdzeń na minutę na klucz, raporty (liczby dnia, braki, rezerwacje, sprzedaż) 300 razy na dobę. Po
  przekroczeniu asystent dostaje informację, za ile sekund spróbować ponownie.
- Lista zamówień obejmuje zamówienia **zmienione w ostatnich 14 dniach**; starsze sprawdzisz po numerze
  („co z zamówieniem …?”).
