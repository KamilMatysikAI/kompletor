# Zewnętrzne źródła i licencje (THIRD_PARTY_NOTICES)

Kompletor jest na licencji AGPL-3.0 (plik `LICENSE`). Ten plik wymienia źródła spoza projektu, z których przygotowano części kodu, z ich licencjami i wymaganymi informacjami. Kolejne integracje oparte na zewnętrznych źródłach dopisują tu swój punkt.

## Noto Sans, SIL Open Font License 1.1

Czcionki wydruków `lib/wydruki/fonty/NotoSans-Regular.ttf` i `NotoSans-Bold.ttf`: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic), SIL Open Font License 1.1. Pełny tekst licencji leży obok czcionek: `lib/wydruki/fonty/OFL.txt`.

## Simple Icons, CC0 1.0

Logo marek na ekranie Ustawienia → Integracje pochodzą z Simple Icons (https://simpleicons.org, pakiet `simple-icons` 16.37.0), udostępnionych na licencji CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/). Do plików dodaliśmy tylko kolor marki z tego samego pakietu. Znaki towarowe należą do ich właścicieli; używamy ich wyłącznie do wskazania, z którym systemem Kompletor się łączy (wytyczne: `DISCLAIMER.md` pakietu Simple Icons). Pliki: `app/(panel)/ustawienia/integracje/loga/allegro.svg`, `woocommerce.svg`, `prestashop.svg`, `dpd.svg`, `claude.svg`. Pozostałe pliki w tym katalogu (`sklep.svg`, `paczka.svg`, `dokument.svg`, `koperta.svg`, `klucz.svg`) to własne ikony Kompletora.

Układ ustawień w działach z zakładkami, ekranu Integracje i kafli kompletności produktów wzoruje się na TwojOMS (MIT, github.com/TwojOMS/twoj-oms); kod i style są napisane od nowa, bez fragmentów źródła.

## Open Integration Platform (Pinquark.com), Apache License 2.0

Kompletor zawiera kod przygotowany na podstawie Open Integration Platform, Copyright 2024-2026 Pinquark.com, Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

Zakres: adapter przewoźnika Orlen Paczka. Z konektora `integrators/courier/orlenpaczka/v1.0.0/src/integration.py` (commit `ae43d1e`) wzięliśmy wiedzę o API: nazwy metod SOAP, nazwy pól przesyłki i tabelę kodów zwrotnych. Kod Kompletora jest napisany od nowa w TypeScript i zmieniony względem źródła (kontrakt adapterów Kompletora, klasy błędów, idempotencja, pola według dokumentacji Orlen Paczki 1.26.004). Pliki:

- `lib/adaptery/orlenpaczka.ts`
- `lib/adaptery/orlenpaczka-kody.ts`
- `lib/zrodla/orlenpaczka.ts`
- `lib/wysylka/orlenpaczka.ts`
- `lib/wysylka/zlecenie-orlenpaczka.ts`

Zakres: rejestr synchronizacji stanów. Z `platform/core/sync_state.py` (ten sam commit `ae43d1e`) wzięliśmy wzorzec: skrót treści, decyzja SYNC / UPDATE / SKIP / RETRY, licznik prób. Własna implementacja w TypeScript: `lib/kanaly/rejestr-synchronizacji.ts`.

Zakres: kanał sprzedaży IdoSell. Z konektora `integrators/ecommerce/idosell/v1.0.0/src/idosell/` (`client.py`, `auth.py`, `mapper.py`, `integration.py`, `schemas.py`, ten sam commit `ae43d1e`) wzięliśmy wiedzę o Admin API: ścieżki wyszukiwania zamówień i produktów, stronicowanie od zera, nagłówek `X-API-KEY`, symbole statusów zamówień, nazwy pól zamówienia, produktu, rozmiaru i stanu, obsługę 429. Kod Kompletora jest napisany od nowa w TypeScript i zmieniony względem źródła (kontrakt adapterów, zapis stanu operacją „set” przez `PUT products/stocks`, wynik per oferta, wyłącznik zapisu, pola według dokumentacji IdoSell Admin API v8; bez trybu „legacy”, odczytu panelu i tworzenia paczek). Pliki: `lib/adaptery/idosell.ts`, `lib/zrodla/idosell.ts`.

Zakres: limity tempa per czynność i automatyczne wyłączanie zepsutej integracji. Z `platform/core/connector_rate_limiter.py` i `platform/core/connector_health.py` (ten sam commit `ae43d1e`) oraz z pól `rate_limits.per_action` manifestów konektorów Allegro i InPost wzięliśmy wzorzec: limit globalny i per czynność w manifeście, kubełek żetonów, licznik kolejnych porażek per instancja i wyłączenie po progu. Własna implementacja w TypeScript, bez Redisa (stan w Postgresie), z innym podziałem ról (porażką jest tylko błąd uwierzytelnienia albo konfiguracji, wyłączenie nie zmienia konfiguracji konta, „Włącz ponownie” przez test połączenia). Z manifestów wzięliśmy dwie liczby: tworzenie przesyłek Allegro 120/min i InPost 30/min. Pliki: `lib/integracje/limity.ts`, `lib/integracje/zdrowie.ts`, `lib/integracje/oslona.ts`.

Zakres: adapter przewoźnika GLS przez ADE. Z konektora `integrators/courier/gls/v1.0.0/src/integration.py` i `config.py` (ten sam commit `ae43d1e`) wzięliśmy wiedzę o API ADE: sesja `adeLogin` / `adeLogout`, kolejność nadania (`adePreparingBox_Insert` → `adePickup_Create` → `adePickup_GetConsignBinds` → `adePickup_GetConsign`), nazwy pól przesyłki, etykiety jedno- i wielopaczkowe (`adePickup_GetParcelLabel`, `adePickup_GetParcelsLabels`, tryb PDF) i adres testowy. Kod Kompletora jest napisany od nowa w TypeScript i zmieniony względem źródła (kontrakt adapterów, klasy błędów ADE, idempotencja z odciskiem referencji i dokańczaniem przygotowania, odszukanie po referencji, wyłącznik zapisu). Pliki:

- `lib/adaptery/gls.ts`
- `lib/adaptery/gls-kody.ts`
- `lib/zrodla/gls.ts`
- `lib/wysylka/gls.ts`

Zakres: adapter przewoźnika Poczta Polska, eNadawca. Z konektora `integrators/courier/pocztapolska/v1.0.0/src/integration.py` i opisu `docs/courier/pocztapolska/v1.0.0/` (ten sam commit `ae43d1e`) wzięliśmy wiedzę o API: dwie usługi SOAP (eNadawca z HTTP Basic, Śledzenie z WSSE), nazwy metod przepływu nadania i wydruku, pola adresu i przesyłki Pocztex, progi formatów S…2XL, statusy śledzenia. Kod Kompletora jest napisany od nowa w TypeScript i zmieniony względem źródła (bufor partii Kompletora i usuwanie tylko po GUID zamiast czyszczenia całego bufora konta, GUID z referencji i odszukanie po nim, klasy błędów, wyłącznik zapisu). Pliki: `lib/adaptery/pocztapolska.ts`, `lib/adaptery/pocztapolska-kody.ts`, `lib/zrodla/pocztapolska.ts`, `lib/wysylka/pocztapolska.ts`.

W repozytorium nie ma plików źródłowych Open Integration Platform.

### Treść pliku NOTICE Open Integration Platform

```
Open Integration Platform
Copyright 2024-2026 Pinquark.com

This product is licensed under the Apache License, Version 2.0 (the "License").
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

This product includes software developed by Pinquark.com (https://pinquark.com).
```

### Pełny tekst licencji Apache License 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by the Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding any notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   TRADEMARK NOTICE

   Copyright 2026 Meritus S.A. (Pinquark)

   See NOTICE file for trademark information.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## elkjs, Eclipse Public License 2.0

Pakiet `elkjs` (Eclipse Layout Kernel w JavaScripcie, https://github.com/kieler/elkjs, licencja EPL-2.0: https://www.eclipse.org/legal/epl-2.0/) trafia do instalacji jako zależność narzędzia Prisma (`prisma` → `@prisma/studio-core` → `elkjs`), które służy do migracji bazy i podglądu danych (Prisma Studio). Kod Kompletora go nie importuje: panel i kolejka z niego nie korzystają. W obrazie leży razem z CLI Prismy w osobnym katalogu `/opt/migrate` jako niezmieniony, osobny program (agregacja), nie jako część utworu na licencji AGPL-3.0. Kod źródłowy pakietu jest dostępny pod adresem repozytorium podanym wyżej i w `node_modules/elkjs` po `npm ci`.
