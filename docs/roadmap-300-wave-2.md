# NodeUO — fala 2: 300 ulepszeń

Zasady: standardowy protokół Ultima Online pozostaje bez zmian. Funkcje oznaczone `[N+]` korzystają wyłącznie z negocjowanego rozszerzenia NodeUO i zawsze mają bezpieczny fallback. Każdy punkt kończy się kodem, automatyczną regresją albo mierzalnym audytem; samo dodanie wpisu nie oznacza ukończenia.

Status: **300/300 punktów wdrożonych i zweryfikowanych** (`pnpm audit:wave2-300:full`). Dowody 1:1: [klient](../artifacts/wave2-quality-client.md), [serwer](../artifacts/wave2-quality-server.md), [admin](../artifacts/wave2-quality-admin.md).

## Klient — 100

1. [x] Adaptacyjny budżet pamięci atlasów zależny od `deviceMemory`.
2. [x] Osobne budżety LRU dla land, static, gump, anim i texmap.
3. [x] Zwolnienie stron atlasu po długiej nieaktywności karty.
4. [x] Telemetria trafień i chybień cache grafik.
5. [x] Priorytet ładowania chunków zgodny z kierunkiem ruchu.
6. [x] Priorytet chunków widocznych nad pierścieniem prefetch.
7. [x] Anulowanie pracy chunków usuniętych przed ukończeniem.
8. [x] Jeden scheduler zadań streamingu z budżetem na klatkę.
9. [x] Dynamiczny budżet streamingu zależny od czasu poprzedniej klatki.
10. [x] Ograniczenie równoległego dekodowania grafik.
11. [x] Deduplikacja żądań tego samego zasobu między gumpem i światem.
12. [x] Wstępne ogrzewanie grafik kierunku ruchu bez blokowania renderu.
13. [x] Szybkie czyszczenie chunków po zmianie facetu.
14. [x] Miękkie i twarde progi liczby chunków.
15. [x] Alarm diagnostyczny dla chunków pozostających poza zasięgiem.
16. [x] Pool geometrii terenu o ograniczonym rozmiarze.
17. [x] Pool nakładek animowanej wody.
18. [x] Pomijanie animacji całkowicie poza viewportem.
19. [x] Redukcja częstotliwości animacji w tle.
20. [x] Automatyczny profil jakości dla słabszych GPU.
21. [x] Centralny katalog brakujących assetów z licznikami.
22. [x] Stabilny placeholder zależny od rodzaju brakującego assetu.
23. [x] Jednorazowe logowanie brakującej grafiki zamiast spamu.
24. [x] Eksport raportu brakujących body, statików i gumpów.
25. [x] Walidacja wymiarów i UV tekstur przed montażem.
26. [x] Ochrona przed callbackiem assetu po dispose kontrolki.
27. [x] Generacje własności dla wszystkich asynchronicznych sprite’ów.
28. [x] Reset świata klienta jako jedna atomowa operacja.
29. [x] Reset handlerów i kolejek na reconnect.
30. [x] Reset pogody, światła, targetu i drag state na reconnect.
31. [x] Odrzucanie pakietów starej sesji po ponownym połączeniu.
32. [x] Watchdog braku postępu dekodera sieciowego.
33. [x] Ograniczony bufor nieznanych opcode do diagnostyki.
34. [x] Raport resynchronizacji z offsetem i sygnaturą pakietu.
35. [x] Automatyczna prośba o resync po serii błędów ramek.
36. [x] Odporność na podwójne `enter world`.
37. [x] Odporność na usunięcie obiektu podczas jego renderowania.
38. [x] Atomowa wymiana ekwipunku paperdolla.
39. [x] Atomowa aktualizacja zawartości kontenera.
40. [x] Kontrola spójności parent/slot/serial po każdej paczce zmian.
41. [x] Walidacja zapisanych pozycji gumpów względem bieżącego viewportu.
42. [x] Migracja layoutu po zmianie UI scale.
43. [x] Profile układu interfejsu per rozdzielczość.
44. [x] Eksport i import układu gumpów.
45. [x] Reset pojedynczego gumpa do pozycji domyślnej.
46. [x] Przywracanie okien z niedostępnego monitora.
47. [x] Magnetyczne krawędzie z konfigurowalnym progiem.
48. [x] Blokada przesuwania kluczowych gumpów.
49. [x] Tryb kompaktowy bocznych paneli.
50. [x] Automatyczne ukrywanie pustych paneli bocznych.
51. [x] Jednolita skala minimalnego tekstu.
52. [x] Ostrzeżenie, gdy ustawiona skala powoduje overflow.
53. [x] Pomiar kontrastu tekstu względem tła gumpa.
54. [x] Tryb bez migotania dla efektów światła i pogody.
55. [x] Sterowanie intensywnością animowanej wody.
56. [x] Sterowanie gęstością efektów pogodowych.
57. [x] Osobna głośność kroków, ambientu i efektów UI.
58. [x] Automatyczne wyciszenie po utracie focusu jako opcja.
59. [x] Czytelny wskaźnik utraty połączenia bez blokowania UI.
60. [x] Pasek postępu reconnect z możliwością anulowania.
61. [x] [N+] Panel diagnostyki zasobów dostępny w grze.
62. [x] [N+] Podgląd opóźnienia klient–serwer i jitteru.
63. [x] [N+] Wykres czasu klatki z ostatnich 10 sekund.
64. [x] [N+] Podgląd kolejki chunków i assetów.
65. [x] [N+] Eksport paczki diagnostycznej bez danych logowania.
66. [x] Wyszukiwarka otwartych gumpów.
67. [x] Skrót zamknięcia wszystkich nieprzypiętych gumpów.
68. [x] Skrót przeniesienia gumpów do widocznego obszaru.
69. [x] Historia ostatnio zamkniętych gumpów.
70. [x] Cofnięcie przypadkowego zamknięcia lokalnego gumpa.
71. [x] Kolejka tooltipów z priorytetem obiektu pod kursorem.
72. [x] Cache tooltipów z rewizją właściwości.
73. [x] Porównanie tooltipu wyposażenia z trzymanym itemem.
74. [x] Przypinane tooltipy nieblokujące targetowania.
75. [x] Menu kontekstowe zawsze utrzymywane w viewportcie.
76. [x] Klawiaturowe sterowanie menu kontekstowym.
77. [x] Wyszukiwarka akcji w action barze.
78. [x] Wielostronicowy action bar.
79. [x] Profile action bara per postać.
80. [x] Import/eksport makr i action bara jako jednego profilu.
81. [x] Licznik sprite’ów, meshów i tekstur w debug HUD.
82. [x] Licznik aktywnych listenerów i timerów sceny.
83. [x] Detektor długich zadań z nazwą podsystemu.
84. [x] Znaczniki czasu ładowania chunków w HUD.
85. [x] Heatmapa kosztu renderowania chunków.
86. [x] Overlay granic chunków i ich stanu kolejki.
87. [x] Overlay przyczyn ukrycia dachu.
88. [x] Overlay kolejności z-depth wskazanego tile’a.
89. [x] Nagranie i deterministyczne odtworzenie krótkiej sesji pakietów.
90. [x] Redakcja danych konta w nagraniach diagnostycznych.
91. [x] Test soak cache i chunków podczas teleportów.
92. [x] Test reconnect bez podwójnych listenerów.
93. [x] Test atomowej aktualizacji kontenera i paperdolla.
94. [x] Test wszystkich fallbacków brakujących assetów.
95. [x] Test layoutu po zmianie DPI i rozmiaru viewportu.
96. [x] Test menu kontekstowego przy każdej krawędzi ekranu.
97. [x] Test budżetu pracy streamingu na klatkę.
98. [x] Test pamięci po wielokrotnej zmianie facetu.
99. [x] Bramka zerowych niezłapanych Promise rejection.
100. [x] Zbiorczy raport jakości klienta w JSON i Markdown.

## Serwer — 100

1. [x] Budżet pracy widoczności na pojedynczy tick.
2. [x] Kolejkowanie kosztownych odświeżeń otoczenia.
3. [x] Koalescencja wielu refreshów tego samego klienta.
4. [x] Priorytet odświeżenia po teleportacji nad ruchem tła.
5. [x] Limit liczby obiektów serializowanych w jednej turze.
6. [x] Adaptacyjny zasięg aktualizacji przy przeciążeniu.
7. [x] Cache wyników widoczności z rewizją sektora.
8. [x] Rewizje sektorów po każdej zmianie zawartości.
9. [x] Statystyki trafień cache widoczności.
10. [x] Audyt wywołań omijających indeks sektorów.
11. [x] Indeks statików runtime per sektor i tile.
12. [x] Indeks spawnerów per sektor i facet.
13. [x] Indeks teleportów, drzwi i znaków per tile.
14. [x] Indeks aktywnych efektów obszarowych.
15. [x] Indeks subskrybentów regionów i pogody.
16. [x] Walidator spójności indeksów uruchamiany w tle.
17. [x] Samonaprawa brakującego wpisu indeksu.
18. [x] Raport osieroconych wpisów indeksu.
19. [x] Pomiar kosztu zapytania sektorowego.
20. [x] Bramka zakazująca pełnych skanów świata w ticku.
21. [x] Twardy limit `bufferedAmount` per klient.
22. [x] Miękki próg backpressure z koalescencją pakietów.
23. [x] Priorytety pakietów krytycznych i kosmetycznych.
24. [x] Pomijanie przestarzałych kosmetycznych aktualizacji.
25. [x] Limit liczby wysyłek per klient na tick.
26. [x] Metryka czasu oczekiwania pakietu w kolejce.
27. [x] Metryka odrzuconych/coalesced pakietów.
28. [x] Kontrolowane rozłączenie klienta, który nie odbiera.
29. [x] Oddzielne progi backpressure dla TCP i WebSocket.
30. [x] Test wolnego odbiorcy bez wzrostu pamięci.
31. [x] Watchdog czasu ticka z nazwami faz.
32. [x] Histogram czasu wykonania systemów świata.
33. [x] Top-N najwolniejszych callbacków skryptów.
34. [x] Alarm dla synchronicznego I/O w ticku.
35. [x] Licznik pominiętych zadań po przekroczeniu budżetu.
36. [x] Adaptacyjny budżet AI zależny od opóźnienia ticka.
37. [x] Adaptacyjny budżet spawnerów.
38. [x] Rozłożenie decay i regen między tickami.
39. [x] Sprawiedliwa kolejka zadań między sektorami.
40. [x] Endpoint profilu ostatnich 60 sekund.
41. [x] Transakcyjny reload pojedynczego skryptu.
42. [x] Walidacja eksportów przed aktywacją skryptu.
43. [x] Rollback rejestrów po błędzie `register`.
44. [x] Rollback disposerów po częściowym reloadzie.
45. [x] Limit czasu inicjalizacji skryptu.
46. [x] Izolacja błędu timera należącego do skryptu.
47. [x] Rejestr listenerów należących do skryptu.
48. [x] Automatyczne usunięcie listenerów przy unload.
49. [x] Historia reloadów z wynikiem i czasem.
50. [x] Dry-run reload bez zmiany aktywnego runtime.
51. [x] Jedno źródło metadanych komend.
52. [x] Raport aliasów komend wskazujących ten sam handler.
53. [x] Raport nieosiągalnych komend.
54. [x] Raport komend bez jawnego poziomu dostępu.
55. [x] Walidacja konfliktów nazw po normalizacji.
56. [x] Walidacja help/usage/example przy starcie.
57. [x] Indeks komend budowany raz po reloadzie.
58. [x] Wyszukiwanie rozmyte komend bez pełnego skanu.
59. [x] Sugestia poprawnej komendy po literówce.
60. [x] Telemetria użycia komend bez treści prywatnych argumentów.
61. [x] Limit równoległych target callbacków per klient.
62. [x] Timeout i cleanup każdego target callbacku.
63. [x] Token sesji dla callbacków gumpów i targetów.
64. [x] Odrzucanie odpowiedzi po reconnect starej sesji.
65. [x] Limit aktywnych gumpów serwerowych per klient.
66. [x] Limit rozmiaru odpowiedzi tekstowej gumpa.
67. [x] Walidacja zakresów wartości switch/text.
68. [x] Audit log odrzuconych odpowiedzi bez spamowania.
69. [x] Rate limit otwierania ciężkich gumpów.
70. [x] Test fuzz lifecycle gump–target–disconnect.
71. [x] Snapshot RNG dla deterministycznych testów świata.
72. [x] Deterministyczny zegar dla skryptów w testach.
73. [x] Nagrywanie sekwencji zdarzeń krytycznej transakcji.
74. [x] Id korelacji dla cast, craft, trade i vendor.
75. [x] Śledzenie rollbacków transakcji.
76. [x] Licznik wykrytych prób duplikacji itemu.
77. [x] Audyt zmian parent/layer itemu.
78. [x] Spójność wagi postaci po rollbacku.
79. [x] Spójność indeksów po restore snapshotu.
80. [x] Chaos-test przerwania zapisu i restartu.
81. [x] Endpoint health rozdzielający live i ready.
82. [x] Readiness zależne od świata, skryptów i indeksów.
83. [x] Graceful shutdown z limitem czasu.
84. [x] Drain połączeń przed końcowym snapshotem.
85. [x] Sygnalizacja postępu shutdownu.
86. [x] Ochrona przed drugim równoległym shutdownem.
87. [x] Walidacja konfiguracji i sekretów przed startem.
88. [x] Raport czasu każdej fazy startu w JSON.
89. [x] Cache manifestu skryptów i danych.
90. [x] Start bez pełnego importu nieużywanych narzędzi admina.
91. [x] Benchmark 10k mobile w indeksie sektorowym.
92. [x] Benchmark 100k itemów i zapytań tile.
93. [x] Soak backpressure z wolnym WebSocketem.
94. [x] Soak reloadów skryptów bez wzrostu listenerów.
95. [x] Test watchdogów przy sztucznym długim ticku.
96. [x] Test koalescencji odświeżeń widoczności.
97. [x] Test readiness podczas startu i shutdownu.
98. [x] Test raportu konfliktów komend i skryptów.
99. [x] Bramka architektoniczna zakazująca nowych pełnych skanów.
100. [x] Zbiorczy raport jakości serwera w JSON i Markdown.

## Admin — 100

1. [x] Wirtualizowana tabela mobile.
2. [x] Wirtualizowana tabela itemów.
3. [x] Wirtualizowana tabela spawnerów.
4. [x] Wirtualizowana tabela kont i sesji.
5. [x] Wirtualizowany katalog statików.
6. [x] Wirtualizowany katalog body i animacji.
7. [x] Stabilne klucze wierszy bez przebudowy całej listy.
8. [x] Bufor nad i pod viewportem listy.
9. [x] Pomiar czasu renderowania tabeli.
10. [x] Budżet maksymalnej liczby elementów DOM.
11. [x] AbortController per zapytanie mapy.
12. [x] Anulowanie requestu po zmianie facetu.
13. [x] Anulowanie requestu po zmianie narzędzia.
14. [x] Deduplikacja identycznych requestów tile/chunk.
15. [x] Cache LRU odpowiedzi mapy.
16. [x] Rewizja cache po edycji świata.
17. [x] Priorytet chunków pod kursorem.
18. [x] Ograniczenie równoległych requestów mapy.
19. [x] Retry z wykładniczym opóźnieniem dla odczytów.
20. [x] Brak automatycznego retry dla mutacji.
21. [x] Historia operacji edytora jako jawne komendy.
22. [x] Undo dodania statika.
23. [x] Undo usunięcia statika.
24. [x] Undo zmiany Z i hue.
25. [x] Undo przeniesienia spawnera.
26. [x] Undo operacji wielokrotnej.
27. [x] Redo wszystkich wspieranych operacji.
28. [x] Limit rozmiaru historii z ostrzeżeniem.
29. [x] Czytelny podgląd operacji przed cofnięciem.
30. [x] Skróty klawiaturowe undo/redo.
31. [x] Walidacja formularzy przy każdej zmianie.
32. [x] Błąd przypięty do konkretnego pola.
33. [x] Podsumowanie błędów dostępne klawiaturą.
34. [x] Blokada zapisu formularza z błędami.
35. [x] Walidacja zakresu x/y względem facetu.
36. [x] Walidacja Z, hue, graphic i body.
37. [x] Walidacja nazw szablonów i skryptów.
38. [x] Ostrzeżenie o niezapisanych zmianach.
39. [x] Bezpieczne opuszczenie widoku z potwierdzeniem.
40. [x] Zachowanie szkicu formularza lokalnie.
41. [x] Panel kondycji ticka i lag spikes.
42. [x] Panel kolejek sieciowych i backpressure.
43. [x] Panel widoczności i indeksów sektorowych.
44. [x] Panel schedulerów AI i spawnerów.
45. [x] Panel runtime skryptów i reloadów.
46. [x] Panel snapshotów, migracji i journalu.
47. [x] Panel pamięci procesu i heap trend.
48. [x] Panel aktywnych alertów.
49. [x] Jednoznaczne statusy live/ready/degraded.
50. [x] Eksport diagnostyki jako JSON.
51. [x] Filtrowanie katalogu statików po nazwie i ID.
52. [x] Kategorie statików generowane z tiledata.
53. [x] Ulubione statiki administratora.
54. [x] Ostatnio używane statiki.
55. [x] Podgląd hue przed umieszczeniem.
56. [x] Podgląd wysokości i flag kolizji.
57. [x] Obrót/variant tam, gdzie wspiera go template.
58. [x] Pędzel prostokątny, liniowy i fill z limitem.
59. [x] Warstwa podglądu zmian przed zapisem.
60. [x] Jedna atomowa operacja zapisu batcha.
61. [x] Grupowanie spawnerów w tym samym tile.
62. [x] Rozsuwanie markerów skupionych spawnerów.
63. [x] Filtry aktywny/wyłączony/typ/region.
64. [x] Edycja wielu spawnerów jednocześnie.
65. [x] Symulacja rozkładu spawnów przed zapisem.
66. [x] Wykrywanie spawnerów poza mapą.
67. [x] Wykrywanie nakładających się spawnerów.
68. [x] Szybkie przejście do właściciela/regionu/template.
69. [x] Teleport bez blokowania interfejsu.
70. [x] Status i możliwość anulowania teleportu.
71. [x] Globalna paleta poleceń z fuzzy search.
72. [x] Nawigacja do obiektu po serialu.
73. [x] Nawigacja do współrzędnych z walidacją.
74. [x] Ostatnie wyszukiwania administratora.
75. [x] Linkowalne filtry i wybrany obiekt w URL.
76. [x] Przywrócenie widoku po odświeżeniu strony.
77. [x] Wielokrotne zakładki robocze edytora.
78. [x] Przypinanie najczęściej używanych narzędzi.
79. [x] Skróty klawiaturowe narzędzi mapy.
80. [x] Pomoc kontekstowa ze skrótami.
81. [x] Optymistyczne odczyty z jawnym stanem oczekiwania mutacji.
82. [x] Idempotency key dla mutacji panelu.
83. [x] Wykrywanie konfliktu rewizji obiektu.
84. [x] Dialog merge/reload przy konflikcie.
85. [x] Audit trail zmian z filtrowaniem.
86. [x] Podgląd diffu JSON przed operacją ryzykowną.
87. [x] Cofnięcie wspieranych mutacji z audit trail.
88. [x] Wygaśnięcie sesji z zachowaniem lokalnego szkicu.
89. [x] Automatyczne odnowienie CSRF/session tokenu.
90. [x] Brak sekretów i tokenów w logach przeglądarki.
91. [x] Test 100k wierszy bez przekroczenia budżetu DOM.
92. [x] Test anulowania i deduplikacji requestów mapy.
93. [x] Test pełnego undo/redo operacji batch.
94. [x] Test walidacji każdego formularza.
95. [x] Test konfliktu rewizji i idempotency key.
96. [x] Test reconnect panelu do kanału telemetrycznego.
97. [x] Test dostępności klawiaturą kluczowych widoków.
98. [x] Test responsywności dla desktopu i tabletu.
99. [x] Bramka wydajności mapy, tabel i panelu zdrowia.
100. [x] Zbiorczy raport jakości admina w JSON i Markdown.
