# Bezpieczeństwo

## Zgłaszanie podatności

Podatności zgłaszaj mailem na **kontakt@etin.pl**, nie w publicznym zgłoszeniu (issue) ani w pull requeście.
Odpowiemy, potwierdzimy przyjęcie i ustalimy z Tobą termin poprawki oraz ujawnienia.

W zgłoszeniu podaj:

- wersję albo commit Kompletora i sposób uruchomienia (`docker compose`, własna platforma, tryb `self-host` czy
  `hosted`),
- opis problemu i jego skutek (np. dostęp do danych innej firmy, obejście logowania, wyciek klucza),
- kroki do odtworzenia albo przykład żądania,
- czy problem jest już znany publicznie.

Nie dołączaj prawdziwych danych klientów ani kluczy API. Jeśli do pokazania problemu potrzebne są dane, użyj firmy
demo (`KOMPLETOR_SEED=demo`).

## Wspierane wersje

Poprawki bezpieczeństwa trafiają do najnowszej wersji z gałęzi `main`. Starszych wersji nie łatamy osobno:
aktualizacja to `git pull` i `docker compose up -d --build`.
