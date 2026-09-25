# Pełny audyt projektu NodeUO — 2026-09-25

## Stan audytu

Audyt obejmuje kod klienta, serwera, skryptów, bridge, panelu Electron, panelu
administracyjnego, pakietów protokołu i ekstrakcji, zasobów gry, launcherów,
dokumentacji, zależności oraz automatycznych bramek. Punktem wyjścia jest
`40c104f` z niezacommitowanymi zmianami w tym katalogu roboczym. To ocena
aktualnego zestawu zmian, a nie certyfikat wydania. Wcześniejszy raport z
[2026-09-07](full-project-audit-2026-09-07.md) pozostaje zachowany jako osobny
zapis historyczny; jego wyniki nie są automatycznie przypisane temu przebiegowi.

**Wynik główny: `pnpm test` 1561/1561, `pnpm audit:50:full` 50/50 i
zawarty w nim pełny audyt jakości 12/12.** Zapisane artefakty
`artifacts/nodeuo-50-audit.json` (`2026-09-25T01:21:35Z`) oraz
`artifacts/nodeuo-quality-audit.json` (`01:18:48Z`) mają `ok: true`.
Poprzednie niezaliczone przebiegi zostały naprawione i ponowione. Końcowe
lint, build, audyt zależności i pakiet 300 punktów również przeszły po
ostatnich edycjach. Jedyną nierozstrzygniętą bramką automatyczną z tego
raportu jest zewnętrzne GitHub Actions CI, którego nie uruchomiono dla
nieopublikowanego diffu.

## Metoda i zakres

Przejrzano różnice względem `40c104f`, konfigurację workspace i skryptów,
przepływy startu, logowania, gry i zamykania, obsługę czasu w tickach,
rejestrację oraz przeładowanie skryptów, zarządzanie procesami, ustawienia
sieciowe, zależności, testy jednostkowe i E2E oraz artefakty audytowe.
Sprawdzono również lokalne drzewa referencyjne `templates/ServUO` i
`templates/ClassicUO`. Katalog `templates/` i wyekstrahowane assety UO są
ignorowane przez Git; czysty clone ich nie zawiera. Mapowanie klas jest
inwentarzem pokrycia z odniesieniami do implementacji i testów, nie dowodem
identycznego zachowania każdego systemu.

| Obszar | Badane ścieżki i kontrakty |
| --- | --- |
| Klient | logowanie i ponowne wejście do świata, cold load assetów, worker JSON, renderowanie, pamięć po ukryciu karty, DOM/Pixi, sieć, gumpy, browser matrix |
| Serwer | konfiguracja, konta i auth, protokół WS/TCP, ticki, rejestry skryptów, hot reload, AI, spawnery, persistence, kontrolowane zamknięcie |
| Narzędzia | bridge WS↔TCP, launchery `.sh`/`.bat`, panel Electron, admin UI i Content Studio |
| Dane | atlas/mapa/animacje/paperdoll, źródła referencyjne, extractor Sharp, zgodność ServUO/ClassicUO |
| Jakość | `pnpm test`, lint, build, smoke, E2E, audyty 50 i 300 punktów, bezpieczeństwo lockfile, CI |

## Problemy znalezione i wprowadzone poprawki

### 1. Konfiguracja publicznego shardu mogła uruchomić tryb deweloperski

Domyślny bind WS i TCP obejmował wszystkie interfejsy, podczas gdy
`UO_DEV_AUTO_ACCEPT` automatycznie tworzy nieznane konta. Łatwo było
przypadkiem wystawić shard z tą opcją. Serwer i launchery domyślnie bindują
teraz `127.0.0.1`; walidacja odrzuca automatyczne tworzenie kont na
publicznym WS/TCP oraz w `NODE_ENV=production`. Pierwsze konto Admin na
publicznym shardzie wymaga odrębnego `UO_BOOTSTRAP_ADMIN_PASSWORD`.
Hasło panelu administracyjnego nie służy już jako domyślne hasło konta gry w
takiej konfiguracji. Publiczny admin wymaga jawnego mocnego hasła i
`UO_ADMIN_HTTPS_TERMINATED=1` dla wdrożenia za proxy TLS. Zaktualizowano
QUICKSTART i launchery; hasło nie jest wypisywane na ekran.

### 2. Zamknięcie serwera z panelu mogło utracić ostatni zapis

Panel Electron używał krótkiej próby wywołania endpointu admina, po której
następował wymuszony `taskkill /f`. Taki proces nie wykonywał końcowego zapisu
świata. Dodano tokenowy `POST /internal/shutdown` na listenerze gry i
oczekiwanie na zakończenie procesu. Gdy potwierdzenie nie nadejdzie, panel
zwraca błąd i pozostawia serwer uruchomiony. Endpoint przyjmuje połączenie
z loopback lub z tego samego lokalnego interfejsu, sprawdza bearer token
porównaniem stałoczasowym i uruchamia istniejącą ścieżkę zapisu. Aktualny
smoke zimnego startu wykazuje
HTTP 202, kod wyjścia 0, utworzony końcowy zapis i bazę danych. Panel nie
zabija już automatycznie obcego procesu zajmującego port; taka czynność
wymaga jawnego wyboru operatora. Obsługa niepowodzenia przy zamykaniu panelu
została zaostrzona.

### 3. Bridge miał zbyt szeroki dostęp do celu TCP

Na lokalnym bridge parametr `?target=` mógł wskazać inny adres niż zadany
domyślnie w launcherze. Publiczny bind bez allowlisty pozwalałby użyć bridge
jako otwartego przekaźnika. Teraz publiczny bind wymaga `UO_BRIDGE_ALLOW`, a
przeglądarkowy `Origin` musi wskazywać loopback albo znajdować się na jawnej
liście `UO_BRIDGE_ORIGINS`. Launchery `run-client-bridge` ustawiają zarówno
domyślny cel, jak i allowlistę; panel Electron kopiuje wybrany cel do tej
allowlisty. Dodano test odmowy publicznego bindu, obcego Origin i zmiany
targetu. Native WebSocket bez nagłówka `Origin` jest wspierany, więc Origin
nie jest mechanizmem uwierzytelniania; przy publicznym bridge wymagana jest
ścisła allowlista celu i kontrola dostępu do samego listenera.

### 4. Wejście klienta do świata niepotrzebnie ładowało cały atlas

Klient pobierał i dekodował wszystkie strony land/texmap podczas inicjalizacji
świata. W scenariuszu z drugim klientem etap ten utrzymywał wejście na
bramce przez ponad 30 s. Początkowy teren nadal jest ogrzewany, a reszta
stron jest pobierana przez renderer na żądanie. Pełny preload pozostał
opcją diagnostyczną `preloadAtlasPages: true`. Ekran logowania działa w DOM,
więc zatrzymano ticker Pixi do wejścia w świat. Ograniczono czas początkowego
warm-upu i usunięto zbędną animację tła. Wartość ponad 30 s opisuje
zdiagnozowany stary przebieg; wymierny wynik końcowy wejścia do świata na
maszynie docelowej wymaga osobnego pomiaru.

### 5. Błędy workera i ponowne logowanie mogły zostawić klienta w martwym stanie

Awaria workera JSON, błąd odczytu wiadomości lub `postMessage` pozostawiały
nierozwiązane promisy ładowania. Wszystkie oczekujące żądania są teraz
odrzucane, worker jest zamykany i może zostać odtworzony przy następnej
próbie; dodano smoke odzyskiwania. Po nieudanym przygotowaniu usług świata
cache promisy jest resetowany, co pozwala ponowić logowanie. Formularz
logowania toleruje zablokowane `localStorage`. Klient usuwa też listener
widoczności i timer długiego dotyku przy opuszczeniu sceny; timer redukcji
cache po ukryciu karty nie jest już kasowany przez każdą klatkę.

### 6. Ticki, harmonogram i hot reload skryptów miały błędy czasu/stanu

Wywołanie `onTick` przekazywało sztywne `1.0` s, niezależnie od faktycznego
opóźnienia pętli; teraz używa mierzonego `dtSeconds`. Latarnia odejmowała
sekundy od licznika paliwa w milisekundach, więc jej czas spalania był
zawyżony około tysiąckrotnie. Poprawiono jednostki i test regresji.
Rejestr tickujących itemów może zmienić skrypt pod tą samą nazwą; cache
śledzi teraz każdą mutację rejestru, nie tylko jego rozmiar. Scheduler
uwzględnia czas zakończenia callbacku i pomija zaległe okresy; kolejka
coalescing przenosi promowane zadanie do właściwego priorytetu. Hot reload
rozróżnia importy w tej samej milisekundzie, sprząta nieudanego kandydata i
odtwarza poprzednią implementację bez utraty kolejności. Dodano testy ticków,
reloadu i rollbacku.

### 7. Start postaci i spawnerów wymagał odporności na niepełny katalog

Brak szablonu `spell-schema-codex` mógł przerwać cały startowy loadout maga
przed dodaniem spellbooka. Wydzielono moduł loadoutu z bezpiecznym fallbackiem
Codexu i testem brakującego szablonu. Spawner po wczytaniu świata adoptuje
istniejące moby przed kolejną próbą spawnu, co ogranicza duplikaty po
restarcie. Panel spawnerów odświeża właściwy widok po mutacji. Pod obciążeniem
test E2E nie czekał na asynchroniczne renderowanie i kończył się timeoutem;
`activate()` oraz operacja zbiorcza zwracają teraz Promise, a audyt oczekuje
na gotowość widoku z diagnostyką błędu. Osobny admin browser E2E i 37/37
testów admin routes/assets przeszły po poprawce; pełny `audit:50:full`
również zaliczył grupę admin.

### 8. Moduły assetów i panelu przekroczyły budżet architektury

Obsługę override'ów assetów wyodrębniono z `asset-manager.js` do
`asset-overrides.js`, a katalogi Content Studio z `admin/routes.js` do
`studio-asset-catalog.js`. Testy i audyty architektury chronią limity
rozmiarów modułów. Końcowy `audit:50:full` zaliczył grupę `architecture`,
a pełna bramka jakości wszystkie 12 obszarów.

### 9. Zależności, CI i dokumentacja miały luki

`sharp@0.35.3` miało znane zgłoszenie o wysokiej wadze, a `vitest` i
`@vitest/mocker@4.1.10` zgłoszenie umiarkowane. Podniesiono Sharp do
`0.35.4`, Vitest do `4.1.11` i zaktualizowano lockfile. `pnpm audit` oraz
`pnpm audit --prod` zwracają zero znanych podatności w aktualnym lockfile.
Sprawdzono natywny dekoder Sharp przez zapis obrazu PNG 2×2 oraz testy
extractora 14/14. Dodano CI dla czystego clone: frozen install, pełny audit
zależności, lint, test, build i pięć smoke klienta bez własnościowych assetów.
CI nie było jeszcze uruchomione na GitHubie dla tego diffu. QUICKSTART,
README, `tools/README.md` i dokumentacja referencji opisują rzeczywiste
wymagania Node/pnpm, lokalne bindy, LAN, ekstrakcję i zakres testów.

### 10. Benchmark gęstego AOI mierzył pusty obszar

Domyślny fixture `dense-aoi-query` rozmieszczał wszystkie 12 000 postaci
poza badanym obszarem. Zwracane zero kandydatów pozwalało przejść próg
12 000 zapytań/s bez pomiaru deklarowanej pracy; tryb `--full` miał inny
rozkład kandydatów. Poprawiono rozkład w obu trybach. Każde zapytanie ma
teraz oczekiwane 1600–1920 kandydatów, a benchmark przerywa się przy
niezgodności liczby. Próg 6000 zapytań/s odnosi się do tej zapełnionej
próby. `SectorIndex` buforuje członkostwo sektorów między zmianami i
zachowuje semantykę iteracji `Set` również przy dodaniu lub usunięciu
mobile między kolejnymi `yield`; dodano testy tej własności. Izolowany
`pnpm audit:gameplay-performance:full` przeszedł: 11 074 gęste zapytania/s
przy 48 000 encji i 100 000 zapytaniach. Pozostałe cztery próby też
przeszły: 11,5 mln aktualizacji pozycji/s, 1,24 mln operacji dirty state/s,
7128 serializacji JSON/s i 13,6 mln decyzji QoS/s. Próba mierzy indeks
i powiązane operacje; pełna ścieżka widoczności, pakietów i renderingu
w sesji wielu graczy wymaga oddzielnego pomiaru.

## Skala projektu i dowody automatyczne

| Dowód | Wynik obecnego przebiegu | Granica interpretacji |
| --- | --- | --- |
| `pnpm audit:references` | ServUO: 6145 plików C#, 32 928 043 B, SHA-256 `19bfeaf3…74837`; ClassicUO: 433 pliki C#, 4 953 677 B, SHA-256 `564b53d4…018f` | Drzewa lokalne i ignorowane przez Git; fingerprint obejmuje pliki C#, a nie wszystkie dane źródłowe |
| `pnpm audit:servuo:map:check` | zaliczony; 11 710 rekordów: 11 277 `MATCHED`, 431 `INFRA_MATCHED`, 2 `IGNORED` | Mapowanie katalogowe; brak otwartych rekordów nie dowodzi pełnej parytetowości zachowania |
| `pnpm audit:classicuo:map:check` | zaliczony; 545 rekordów: 158 `MATCHED`, 371 `ARCHITECTURE_MATCHED`, 16 `NOT_APPLICABLE` | Także wymaga lokalnego drzewa ClassicUO |
| `pnpm audit:wave2-300:full` | końcowe artefakty: klient 100/100, serwer 100/100, admin 100/100; mobile 8,25 ms, itemy 178,1 ms, zapytania tile 55,54 ms | Kontrakty statyczne i wybrane dynamiczne |
| `server-startup-smoke` | gotowość 1541 ms w audycie (1268 ms w logu procesu); 387 skryptów załadowanych, 32 świadomie bez default export, 0 błędów/duplikatów/ostrzeżeń; HTTP 202, exit 0, końcowy zapis świata | Jednorazowy zimny start na lokalnej maszynie |
| `network-chaos-replay` | 100 000 pakietów, 1 616 627 B, 15 298 fragmentów, odzyskanie po nieznanym opcode | Deterministyczny corpus, nie pełen test sieci produkcyjnej |
| Obciążenie serwera | 2000 mobile, 20 000 itemów, 20 000 ticków; w izolowanej regresji 670 165 ruchów/s i 17,6 MiB, w końcowym `audit:50:full` 586 063 ruchów/s i 32,9 MiB | Dwa osobne pomiary syntetyczne; brak 12-godzinnego soaka |
| Wydajność gameplay | `audit:gameplay-performance:full` 5/5; gęsty AOI 11 074 zapytań/s przy 1600–1920 kandydatów/zapytanie i progu 6000 | Izolowany mikrobenchmark; nie obejmuje całego przepływu sieć–widoczność–rendering |
| Wydajność 100 systemów | `audit:game-systems-performance:full` zaliczony: 100 systemów, 256 instancji, 2048 graczy, 250 000 działań; 131 508 operacji/s | Syntetyczny scenariusz, zależny od sprzętu |
| Przeglądarki i restart | 3 przeglądarki × 4 rozdzielczości = 12 scenariuszy; E2E restartu dwóch klientów, dom 143 kafle, łódź 32 elementy zaliczone | Istniejące baseline screenshotów zachowano; automatyczna zgodność nie zastępuje oceny grafiki |
| Browser login/runtime | 20 cykli nawigacji/pamięci i 3 cykle trybu opcji zaliczone osobno i w końcowej bramce jakości | Automatyczne cykle nie zastępują długiego testu użytkowego |
| Admin browser E2E | osobny przebieg i końcowy `audit:50:full` zaliczone; testy admin routes/assets 37/37 | Zewnętrzne wdrożenie panelu wymaga konfiguracji TLS i kont |
| Klient i panel | pełny klientowy smoke zaliczony; panel Electron 9/9 testów i smoke zaliczone; lint i build zaliczone | Zewnętrzne CI jeszcze nie uruchomione dla tego diffu |
| Pięć smoke klienta w CI | `startup-ui`, `outgoing`, `incoming-coverage`, `net-handlers`, `perf-budgets`: lokalnie zaliczone | Nie wymagają wyekstrahowanych assetów UO; browser/E2E uruchamiane osobno |
| Zależności i extractor | `pnpm audit` i `pnpm audit --prod`: 0 znanych podatności; Sharp 0.35.4 PNG 2×2; extractor 14/14 | Stan bazy advisory i lockfile na dzień audytu |
| `git diff --check`, `pnpm lint`, `pnpm build` | zaliczone | Wynik lokalny; workflow GitHub jeszcze nie wykonał tych bramek |

Końcowy `nodeuo-quality-audit` ma 12/12 obszarów: visual, movement, protocol,
assets, combat, inventory, gumps, AI, CreateWorld, performance, maps i
persistence. `audit:50:full` ma 50/50 punktów i wszystkie grupy `core`, E2E,
network, load, browser, gameplay, admin oraz architecture zielone.
Pełne testy workspace dały 1561/1561, w tym serwer 1426/1426 w 234 plikach.

## Stan bramek

| Polecenie lub obszar | Aktualny status |
| --- | --- |
| `pnpm test` na całym workspace | **zaliczony: 1561/1561**; serwer 1426/1426 w 234 plikach |
| `pnpm lint` i `pnpm build` | **zaliczone** po ostatnich edycjach |
| Pełny `pnpm --filter @uo/client smoke` | zaliczony; osobny browser runtime audit też zaliczony |
| Panel Electron | 9/9 testów i smoke zaliczone; osobny admin browser E2E również zaliczony |
| `pnpm audit:quality:full` | **zaliczony: 12/12** obszarów w końcowym artefakcie |
| `pnpm audit:50:full` | **zaliczony: 50/50** punktów w końcowym artefakcie |
| `pnpm audit:wave2-300:full` | **zaliczony: 100/100** klient, **100/100** serwer, **100/100** admin |
| `pnpm audit` i `pnpm audit --prod` | **zaliczone:** zero znanych podatności w lockfile |
| GitHub Actions CI | workflow dodany, ale brak wyniku z serwera CI dla tej zmiany |

## Pozostałe ryzyka i zalecenia przed publicznym uruchomieniem

1. **Sprawdzić nowe CI po opublikowaniu zmian.** Wszystkie wymienione bramki
   lokalne przeszły, ale workflow GitHub Actions nie był jeszcze uruchomiony
   dla tego diffu na czystym clone i systemie Linux.
2. **Zmierzyć cold load i długi soak na sprzęcie docelowym.** Usunięcie
   blokującego preloadu i lokalne smoke nie potwierdzają jeszcze p95/p99
   wejścia do świata, frame time, zużycia GPU ani 12 godzin nieprzerwanej
   pracy przy rzeczywistej liczbie graczy. Poprawiony mikrobenchmark AOI
   ma kontrolę liczby kandydatów, ale nie mierzy pełnej ścieżki widoczności.
3. **Zachować dokładne rewizje referencji.** Obecne fingerprinty plików C#
   umożliwiają wykrycie zmiany źródła, lecz lokalne drzewa nie mają własnych
   metadanych Git, więc nie znamy ich upstream commitów. Zapisać te commity
   przy następnym odtworzeniu `templates/`.
4. **Sprawdzić ręcznie native klientów i pełne assety.** CI świadomie działa
   bez plików Ultima Online. Należy przejść logowanie, walkę, paperdoll,
   gumpy, mapy i zapis na legalnie wyekstrahowanych assetach oraz w zewnętrznym
   ClassicUO/Razor/OSI. Macierz 12 scenariuszy przeglądarkowych przeszła bez
   zmiany bazowych screenshotów; pełna ocena artystyczna pozostaje ręczna.
5. **Zweryfikować konfigurację produkcyjną sieci.** Flaga
   `UO_ADMIN_HTTPS_TERMINATED=1` potwierdza intencję operatora, nie bada
   faktycznego proxy TLS. Publiczny bridge wymaga własnej kontroli dostępu.
   Warto wykonać ręczny test start/stop panelu także przy konkretnym LAN IP
   i przy niedostępnym serwerze, obserwując końcowy zapis.
6. **Przetestować awarie persistence na kopii świata.** Smoke potwierdza
   zwykły zapis i restart; nie obejmuje wyczerpania dysku, korupcji SQLite,
   nagłej utraty zasilania ani migracji realnego wielomiesięcznego save.

## Odniesienia

- [Instrukcja źródeł referencyjnych](../reference-sources.md) i
  `artifacts/reference-sources.json` opisują reprodukowalność map.
- [QUICKSTART](../../QUICKSTART.md), [README](../../README.md) oraz
  [tools/README](../../tools/README.md) opisują uruchomienie lokalne i LAN.
- Poprawione wersje wynikają z komunikatów bezpieczeństwa
  [Sharp](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) oraz
  [Vitest mocker](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
- Artefakty JSON w `artifacts/` są lokalne i ignorowane przez Git. Przed
  publikacją wyniku należy zachować ich kopie wraz z dokładnym commitem
  NodeUO oraz stanem drzew referencyjnych.
