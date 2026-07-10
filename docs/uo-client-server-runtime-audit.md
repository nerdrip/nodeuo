# Audyt runtime klienta i serwera UO

Data audytu: 2026-07-10. ClassicUO i ServUO zostały użyte wyłącznie jako
lokalny materiał do porównania zachowania i kompletności. Implementacja
pozostaje własna, dopasowana do JavaScript/PixiJS/WebGL/Node.js.

## Wynik pomiaru bazowego

- Build klienta przechodził, podobnie jak dotychczasowe smoke testy animacji,
  statików i cache. Testy nie weryfikowały jednak jakości wygenerowanych danych.
- Bieżący `mobiles-atlas.json`: 63 strony, 802 ciała, 433 925 użytecznych
  rekordów klatek i 90 ciał z wyłącznie bardzo małymi klatkami.
- Bieżący `static-atlas.json`: 135 stron 2048×2048. PNG zajmują około 60 MB,
  lecz pełne RGBA po dekodowaniu przekracza 2 GB pamięci GPU.
- Pełny test serwera przed zmianami: 132 pliki i 867 testów, wszystkie zielone.

## Naprawione problemy klienta

### Animacje mobilów

- Extractor czyta teraz `AnimationSequence.uop` i mapuje logiczne grupy akcji
  na fizyczne grupy w `AnimationFrame*.uop`.
- Dekoder UOP respektuje `dataStart`, pełną obsługę kompresji UOP i minimalne
  dziesięć klatek dla wyposażenia.
- Manifest zawiera typ i flagi z `mobtypes.txt`, dlatego ID większe niż 400 nie
  oznacza już automatycznie człowieka. Dotyczy to m.in. ciał 717/719.
- Dodano grupy legacy 23–34 (jazda i walka na wierzchowcu) oraz logiczne grupy
  UOP 0–79. Aliasowanie grup nie duplikuje pikseli w atlasie.
- Pakowanie atlasu zachowuje lokalność ciała. Globalne sortowanie po wysokości
  rozrzucało klatki jednego człowieka po większości z 63 stron.
- Klient rozpoznaje pokojowe grupy UOP 22/24/25 oraz wojenne 0/1.

Uwaga: repozytorium nadal zawiera atlas wygenerowany przez poprzedni extractor.
Do zobaczenia poprawionych potworów trzeba go odtworzyć z legalnej instalacji:

```powershell
pnpm --filter @uo/extractor extract -- --src "C:\Path\To\Ultima Online Classic" --out "apps\client\public\assets" --only anim
pnpm --filter @uo/client run smoke:body-coverage
```

Nowy manifest ma `schemaVersion: 2`, `mobTypes` i `uopActions`. Raport ostrzega,
gdy nadal widzi starszy format.

### Statiki i ładowanie

- Animacja statików była poprawnie bramkowana flagą TileData.Animation i
  pozostaje ograniczona do widocznych chunków.
- Start klienta nie ładuje już wszystkich 135 stron statików. Rozgrzewane są
  dwie strony; pozostałe są dociągane równolegle dla widocznych chunków.
- Rozgrzewka mobilów jest ograniczona do dwóch stron 4096×4096, czyli około
  128 MB RGBA zamiast potencjalnych 59 stron i ponad 3,5 GB.
- Eksmisja subtekstury zmniejsza licznik użycia strony atlasu. Wcześniej licznik
  tylko rósł, przez co strony pozostawały na stałe nieusuwalne.

### Efekty i walka

- Efekty graficzne zmieniają teraz klatki z `animdata`, niezależnie od flagi
  animacji zwykłego statika, zgodnie z zachowaniem efektów desktopowych.
- Lot pocisku jest liczony z odległości ekranowej i pola `speed`; pole
  `duration` nadal steruje czasem efektów stałych w jednostkach 50 ms.
- Kierunek pocisku używa wektora ekranowego izometrii, respektowane są wszystkie
  warianty flagi fixed-direction, a cel mobilny jest śledzony w locie.
- `explode` tworzy końcowy efekt 0x36CB lub grafikę `explodeEffect`.
- Legacy 0x0B i AOS 0x22 trafiają do jednego toru: stan walki, liczba obrażeń,
  hit-flash, recoil i GetHit. Usunięto podwójne liczby obrażeń.
- 0x2F obraca gracza w war mode w stronę potwierdzonego przeciwnika.

## Naprawione problemy serwera

- Pętla walki 10 Hz iteruje po indeksie graczy online, a nie po wszystkich NPC.
- Scheduler AI sprawdza obecność graczy przez indeks O(1), zamiast skanować
  wszystkie mobile co 500 ms.
- Serwerowo inicjowane zamknięcie NetState zawsze wykonuje cleanup sesji. Stara
  kolejność ustawiała `_closed` i pomijała cleanup po zdarzeniu `close`.
- Bufor wyjściowy pojedynczego klienta ma limit 4 MB. Ponieważ pakietów świata
  nie można bezpiecznie pomijać, wolny klient jest rozłączany zamiast zużywać
  pamięć bez ograniczenia.
- Cleanup rozłączenia korzysta z sektorów dla obserwatorów i z indeksu petów,
  zamiast kilku pełnych skanów świata.

## Pozostałe różnice wymagające dalszej pracy

Priorytet P0/P1:

1. Wygenerować atlas v2 z lokalnych plików i przeprowadzić test w grze dla
   ciał UOP, wierzchowców, wyposażenia, śmierci, czarów i walki dystansowej.
2. Dodać automatyczny test wizualny ruch → idle → war → attack → getHit → die,
   z kontrolą klatki body, mount i wszystkich warstw wyposażenia.
3. Zastąpić ręczny fallback `BODY_FALLBACK` telemetrią błędnego body; fallback
   ma zostać wyłącznie ochroną dla niepełnych instalacji, nie normalnym torem.
4. Efekty particle i screen-fade są nadal uproszczone. Potrzebny jest system
   definicji efektów i batching instancji, zamiast części fallbacków `Graphics`.
5. Wprowadzić budżet pamięci atlasów liczony w bajtach oraz telemetrykę czasu
   fetch/decode/upload per rodzaj strony. Limit samej liczby stron jest za mało
   precyzyjny przy mieszaniu stron 2048² i 4096².

Priorytet P2 serwera:

1. Zunifikować 43 timery w scheduler z kolejką priorytetową, pomiarem driftu i
   budżetem czasu na puls, analogicznie funkcjonalnie do centralnego TimerSlice.
2. Rozszerzyć aktywację sektorów: kosztowne AI, spawny i skrypty powinny spać,
   gdy sektor oraz sąsiedzi nie mają graczy; walka/pety/bossowie są wyjątkami.
3. Dodać metryki p95/p99 dla pulsu walki, AI, sieci, zapisu oraz liczby aktywnych
   sektorów i kolejki WebSocket. Obecne testy badają poprawność, nie przeciążenie.
4. Zastąpić pozostałe pełne skany `world.items`/`world.mobiles` w gorących
   handlerach indeksami parent/type/owner. Globalne skany admina i zapisu mogą
   pozostać świadome kosztu.
5. Wprowadzić zapisy inkrementalne/journal pomiędzy pełnymi snapshotami oraz
   test przerwania procesu w połowie zapisu i poprawnego odtworzenia świata.

## Kryterium „klient desktopowy”

Pełna zgodność nie powinna być deklarowana na podstawie liczby handlerów. Dla
każdej funkcji potrzebny jest test end-to-end: pakiet/zdarzenie, stan świata,
widoczny rezultat, dźwięk/animacja, cleanup i zachowanie po reconnect/save.
Obecny klient ma szeroki zakres funkcji desktopowych, ale powyższe punkty P0/P1
muszą zostać domknięte przed oznaczeniem pełnej parytetowości.

## Weryfikacja po zmianach

- pełny smoke klienta: przechodzi;
- build produkcyjny Vite: przechodzi;
- extractor: 6/6 testów;
- serwer: 133/133 pliki testowe, 870/870 testów;
- `git diff --check`: bez błędów białych znaków.

Test screenshotów został pominięty przez istniejący runner, ponieważ w tym
środowisku nie jest zainstalowany Playwright. Rzeczywiste assety v2 również nie
zostały wygenerowane, ponieważ repozytorium nie zawiera źródłowych plików UO.
