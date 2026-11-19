# Nagrane odpowiedzi KSeF TEST

Kształty odpowiedzi API KSeF 2.x z przykładów OpenAPI środowiska TEST (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json),
przeniesione z naszych testów systemu najmu (`packages/ksef/test/fixtures/online/`). Numery NIP w plikach to NIP-y
Ministerstwa Finansów z przykładów OpenAPI, nie dane klientów. Atrapa `tests/ksef-atrapa.ts` czyta je i podmienia
tylko numery referencyjne i numer KSeF, żeby każda faktura w teście miała własne.
