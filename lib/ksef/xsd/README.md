# Schematy XSD FA(3)

Katalog walidatora `lib/ksef/fa3/xsd.ts` (zmienna `KSEF_XSD_DIR` wskazuje inny). Cztery pliki MF, skopiowane bajt
w bajt z DewFlow (`liveko-cashflow/lib/ksef/xsd/`, tam sprawdzone na środowisku TEST KSeF; zgoda właściciela praw na kopiowanie
kodu z 02.11.2026):

- `schemat_FA(3)_v1-0E.xsd` — schemat główny (`targetNamespace` `http://crd.gov.pl/wzor/2025/06/25/13775/`),
- `StrukturyDanych_v10-0E.xsd`, `ElementarneTypyDanych_v10-0E.xsd`, `KodyKrajow_v10-0E.xsd` — importy.

Walidator rozpoznaje główny schemat po `targetNamespace` i podmienia adresy `schemaLocation` (http://crd.gov.pl/...)
na pliki z tego katalogu po nazwie pliku, w pamięci; pliki na dysku zostają nietknięte, sieć nie jest potrzebna.
Katalog trafia do obrazu przez `outputFileTracingIncludes` w `next.config.ts`. Nowa wersja schematu MF = podmiana
plików tutaj i przebieg `lib/ksef/fa3/xsd.test.ts` (test zgodności buildera ze schematem jest wymagany).
