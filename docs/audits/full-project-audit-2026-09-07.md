# Pełny audyt projektu NodeUO — 2026-09-07

## Wynik

Audyt objął wszystkie aktywne workspace'y i kod śledzony przez Git: serwer,
skrypty/content, klient i renderery, protokoły UO/NodeUO, panel administracyjny,
launcher Electron, bridge oraz extractory assetów. Pominięto zależności,
wygenerowane katalogi buildów i lokalne, ignorowane przez Git eksperymenty,
ponieważ nie są częścią produktu.

Po poprawkach wszystkie dostępne automatyczne bramki są zielone. Nie pozostał
żaden znany błąd startu, rejestracji skryptów, testów, lintowania, builda,
zgodności protokołu, integralności assetów, panelu administracyjnego ani
budżetów wydajności. Stan bazowy audytu: commit `40c104f`.

Nie oznacza to matematycznej gwarancji, że każda kombinacja 155 zaklęć,
każda klatka każdej animacji i każda wieloosobowa kolejność zdarzeń jest wolna
od błędów. Takiej gwarancji nie daje żaden skończony zestaw testów. Sekcja
„Granice pewności” zapisuje pozostałe ryzyka jawnie.

## Znalezione i naprawione problemy

### 1. Panel spawnerów nie odświeżał się po mutacji

Starszy adres `#spawners` nadal działał dla zapisanych zakładek, ale przycisk
nawigacji został wcześniej przeniesiony. Zapis, usunięcie, respawn i operacja
zbiorcza próbowały odświeżyć ekran kliknięciem nieistniejącego przycisku.
Serwer wykonywał zmianę, lecz ekran pozostawał nieaktualny.

Naprawa:

- wszystkie cztery ścieżki odświeżają teraz widok przez `activate('spawners')`;
- dodano browser E2E, który otwiera ukryty widok, wyłącza spawner zbiorczo,
  sprawdza stan backendu, odświeżenie karty i dostępność interfejsu.

### 2. Startowy Arcane Schema Codex mógł przerwać loadout maga

Tworzenie postaci zakładało, że template `spell-schema-codex` jest już
zarejestrowany. W minimalnym E2E lub krótkim oknie zimnego startu brak template'u
rzucał wyjątek w dużym wspólnym bloku. Przez to późniejszy spellbook maga lub
nekromanty mógł nie zostać utworzony.

Naprawa:

- wydzielono odporny moduł startowego loadoutu;
- Codex ma kompletny bezpieczny fallback z właściwym art ID, skryptem,
  kategorią, wagą i flagami `newbied`, `blessed`, `accountBound`;
- brak template'u nie przerywa kolejnych elementów ekwipunku;
- dodano test regresji oraz powtórzono pełne browser client/server E2E bez
  wcześniejszego ostrzeżenia.

### 3. Dwa moduły przekroczyły budżety architektury

Najnowsze funkcje doprowadziły `asset-manager.js` powyżej limitu 2200 linii,
a `admin/routes.js` powyżej 2000 linii. Nie podniesiono limitów.

Naprawa:

- obsługa manifestu override'ów, niestandardowych grafik i klatek animacji
  została wydzielona do `asset-overrides.js`;
- katalogi assetów Content Studio, wygląd paperdolla, cache i ich endpointy
  zostały wydzielone do `studio-asset-catalog.js`;
- zachowano publiczne API i unieważnianie cache po edycji lub przywróceniu
  profilu;
- finalny audyt architektury przechodzi dla wszystkich 12 pilnowanych modułów.

### 4. Benchmark pamięci mierzył losowy moment GC

Test regresji pamięci potrafił zgłosić 25,7 MiB zamiast budżetu 22 MiB, mimo
że obejmował także tymczasowe obiekty oczekujące na niedeterministyczny cykl
V8. Nie zmieniono progu ani baseline'u.

Naprawa:

- proces benchmarku uruchamia się z `--expose-gc`;
- pomiar jest wykonywany po GC przed i po scenariuszu, więc porównuje pamięć
  rzeczywiście utrzymywaną;
- wynik pełny: 955 187 ruchów/s i 17,6 MiB retained heap — w budżecie.

### 5. Nieaktualne kontrakty audytowe

Pakiet 300 punktów nadal szukał starego tekstu testu przerwanego zapisu,
starej tabeli spawnerów i pól przeniesionych z `routes.js`. Mapa ServUO
traktowała też usunięty, duplikujący zapis spawnerów jako brak implementacji.

Naprawa:

- kontrakty wskazują aktualny test odzyskiwania po przerwanym zapisie,
  stronicowany widok spawnerów i nowy moduł katalogu assetów;
- `SpawnerPersistence` jest jawnie mapowany do autorytatywnego `Spawner`, który
  adoptuje moby z zapisu świata przed pierwszym spawnem;
- istniejący test restartu potwierdza brak podwójnej populacji;
- mapy zgodności ClassicUO i ServUO przechodzą z `--fail-open`.

### 6. Fałszywe ostrzeżenia GPU w smoke-teście launchera

Headless Electron kończył poprawnie, ale podczas natychmiastowego zamykania
emitował ostrzeżenia bufora GPU. Smoke-test nie potrzebuje renderowania GPU,
więc jest teraz uruchamiany z wyłączoną akceleracją. Wynik jest czysty i nadal
sprawdza renderer, IPC, usługi, importery, logi i ustawienia.

## Zakres i wyniki

| Obszar | Zweryfikowany wynik |
| --- | --- |
| Całe repo | `pnpm test`: 230 plików/1412 testów serwera oraz 129 testów pozostałych pakietów; razem 1541, wszystkie zaliczone |
| Jakość kodu | `pnpm lint`, `pnpm build`, `git diff --check`: zaliczone |
| Audyt przekrojowy | `audit:50:full`: 50/50 |
| Audyt wave 2 | `audit:wave2-300:full`: klient 100/100, serwer 100/100, admin 100/100 |
| Zimny start | 387 skryptów załadowanych, 32 moduły świadomie bez default export, 0 błędów, 0 ostrzeżeń; gotowość w 780 ms |
| Protokół | 71/71 rejestracji ServUO porównanych, 74 handlery, 96 testów pakietów; outgoing, próbki ServUO i granica rozszerzeń zaliczone |
| Klient/renderery | pełny łańcuch smoke zaliczony: UI, sieć, mapy, światło, efekty, dachy, pathfinding, cache, pool, paperdoll, drag/drop, makra i profile |
| Gumpy | 95 modułów, 94 eksportowane klasy; round-trip 0xB0, 0xB1 i skompresowany 0xDD; layout i UI parity zaliczone |
| Animacje | 1021 body, 860 580 klatek, 258 stron atlasu, 0 pustych body; mobile/static/effect timing zaliczone |
| Assety | 803 potwory bez generycznego fallbacku, 514 itemów, 5482 gumpy; paperdoll unresolved = 0 |
| AI/spawnery | macierz AI, grafy, mage/healer/vendor AI, pathfinding, spawnery, XmlSpawner i encounters zaliczone |
| Gameplay | 26 plików i 254 testy przekrojowe: walka, śmierć, reagenty, zaklęcia, skille, AI, loot, domy, łodzie, pety, questy, regiony i bossowie |
| CreateWorld | 107 951 dekoracji, 834 znaki, 1374 teleportery, 6788 spawnerów, 889 vendorów i 24 917 referencji |
| Mapy | 6 facetów, 25 180 próbek i 317 238 bloków statics |
| Persistence | save/restart, migracje, domy, łodzie i stabilne encje: 8 plików/48 testów |
| Panel admina | 15 zakładek, Studio/Assets/Data Tree/ISO, operacje mutujące, rollbacki, auth oraz automatyczny audyt dostępności |
| Panel sterowania | 7 przycisków usług, 23 kroki ekstrakcji, renderer/IPC/logi/ustawienia; smoke czysty |
| Odporność sieci | 100 000 pakietów, 1 616 627 bajtów, 15 298 fragmentów; 0 błędów |
| Obciążenie serwera | 2000 mobile, 20 000 itemów, 20 000 ticków; ponad 1 mln ruchów/s w finalnym 50/50 |
| Wydajność gameplay | 27 815 AOI/s, 42,6 mln aktualizacji pozycji/s, 4,25 mln koalescencji dirty-state/s |
| 100 systemów | 256 instancji, 2048 graczy, 250 000/250 000 zaakceptowanych akcji, 264 454 operacji/s |
| Bezpieczeństwo zależności | `pnpm audit --prod`: brak znanych podatności |
| Zgodność katalogów | audyty ClassicUO i ServUO z `--fail-open`: 0 otwartych rekordów |

## Najważniejsze uruchomione polecenia

```text
pnpm test
pnpm lint
pnpm build
pnpm --filter @uo/client smoke
pnpm --filter @uo/control-panel smoke
pnpm audit:50:full
pnpm audit:wave2-300:full
pnpm audit:performance:full
pnpm audit:gameplay-performance:full
pnpm audit:game-systems-performance:full
pnpm audit:item-paperdolls
pnpm audit:servuo
pnpm audit:classicuo:map:check
pnpm audit:servuo:map:check
pnpm audit --prod
node tools/audit/server-startup-smoke.mjs
```

Wygenerowane raporty maszynowe znajdują się w ignorowanym katalogu
`artifacts/`, m.in. `nodeuo-50-audit.json`, `nodeuo-quality-audit.json`,
`performance-regression.json`, `classicuo-client-parity.json` i
`servuo-server-parity.json`.

## Granice pewności

Nie ma obecnie znanego automatycznie odtwarzalnego defektu. Nadal nie należy
przedstawiać wyniku jako dowodu absolutnej „perfekcji”, ponieważ ten przebieg
nie obejmował:

1. ręcznego przejścia każdej kombinacji wszystkich 155 zaklęć i 411 receptur
   na NodeUO oraz zewnętrznym binarnym kliencie ClassicUO;
2. ręcznej oceny każdej z 860 580 klatek, dźwięków i grafik pod względem
   artystycznym — integralność, dekodowanie i reprezentatywne animacje są
   sprawdzone automatycznie;
3. dwunastogodzinnego ciągłego soaka ani realnej telemetrii ekonomii shardu;
4. destrukcyjnego audytu na produkcyjnym save (wipe/recreate/corrupt/disk-full);
   odpowiadające ścieżki były sprawdzane na izolowanych światach i fixture'ach;
5. wszystkich możliwych wyścigów z trzema lub większą liczbą prawdziwych
   klientów dla gildii, frakcji, VvV, vendorów, aukcji i bossów.

Do wydania kod jest w stanie zielonym. Przed uruchomieniem publicznego shardu
zalecany jest jeszcze ręczny acceptance pass najważniejszych podróży gracza
oraz długi soak na maszynie o docelowej konfiguracji.
