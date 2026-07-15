# NodeUO — plan 300 usprawnień

Legenda: `P0` blokuje poprawne działanie, `P1` istotnie poprawia produkt, `P2` rozwija go. `[UO]` używa wyłącznie standardowego protokołu Ultimy. `[N+]` to opcjonalne, negocjowane rozszerzenie NodeUO z bezpiecznym fallbackiem do standardowego zachowania. Zmiany administracyjne używają panelowego HTTP/WS i nie ingerują w protokół gry.

## Klient (100)

1. [x] P0 [UO] Jednolity, deterministyczny pomiar wszystkich gumpów po załadowaniu grafik.
2. [x] P0 [UO] Stabilne rozmiary kontrolek przed i po asynchronicznym wczytaniu atlasu.
3. [x] P0 [UO] Poprawne skalowanie `ResizePic`/nine-slice bez rozciągania rogów.
4. [x] P0 [UO] Wspólny system typografii: czytelne fonty, hinting, kontrast i line-height.
5. [x] P0 [UO] Bezpieczny fallback fontów i glifów Unicode.
6. [x] P0 [UO] Automatyczne zawijanie, skracanie i mierzenie tekstu bez kolizji.
7. [x] P0 [UO] Clipping zawartości do rzeczywistych granic gumpa i scroll-area.
8. [x] P0 [UO] Deterministyczny z-order kontrolek, okien, tooltipów i drag-preview.
9. [x] P0 [UO] Spójne hitboxy przycisków, checkboxów i grafik z testem alpha tam, gdzie potrzebny.
10. [x] P0 [UO] Poprawny focus, blur i przechwytywanie wejścia przez gumpy modalne.
11. [x] P1 [UO] Nawigacja klawiaturą po kontrolkach i widoczny focus-ring.
12. [x] P2 [UO] Opcjonalna obsługa kontrolera dla podstawowych gumpów.
13. [x] P0 [UO] Jednolita obsługa scrolla, touchpada, przeciągania scrollbarów i auto-scroll.
14. [x] P1 [UO] Trwałe pozycje, rozmiary i stan gumpów per postać.
15. [x] P0 [UO] Clamp i odzyskiwanie okien, które znalazły się poza viewportem.
16. [x] P1 [UO] Przyciąganie, dokowanie i grupowe przesuwanie okien.
17. [x] P0 [UO] Poprawna obsługa DPI, zoomu przeglądarki i UI scale.
18. [x] P1 [UO] Responsywny desktop gry dla małych i ultrawide ekranów.
19. [x] P1 [UO] Wspólne semantyczne komponenty: panel, nagłówek, lista, formularz, footer.
20. [x] P1 [UO] Overlay diagnostyczny granic, hitboxów, z-order i czasu renderowania gumpa.
21. [x] P0 [UO] Wizualne testy regresji reprezentatywnych gumpów w Playwright.
22. [x] P0 [UO] Fuzz-test layoutów gumpów serwerowych i złośliwych wartości.
23. [x] P1 [UO] Prefetch i priorytetyzacja grafik aktualnie otwieranego gumpa.
24. [x] P0 [UO] Pełne dispose: anulowanie requestów, listenerów i tekstur po zamknięciu.
25. [x] P1 [UO] Cache tekstu i geometrii oraz pooling bez wycieków pamięci.
26. [x] P2 [UO] Tryb reduced-motion i ograniczenie migotania.
27. [x] P1 [UO] Palety wysokiego kontrastu i rozróżnialne stany bez polegania na kolorze.
28. [x] P1 [UO] Globalna skala UI z natywnym pixel-perfect oraz trybem czytelnym.
29. [x] P0 [UO] Stabilne tooltipy z opóźnieniem, pinowaniem i bez przedwczesnego znikania.
30. [x] P1 [UO] Spójne menu kontekstowe z obsługą uprawnień i skrótów.
31. [x] P0 [UO] Skills: czytelne grupy, nagłówki i lista bez nakładania wierszy.
32. [x] P1 [UO] Skills: wyszukiwarka po nazwie i aliasach.
33. [x] P1 [UO] Skills: sortowanie według nazwy, wartości, capu i ostatniej zmiany.
34. [x] P0 [UO] Skills: poprawne lock up/down/locked i natychmiastowa synchronizacja.
35. [x] P0 [UO] Skills: bezpieczne aktualizacje wartości bez przebudowy całego gumpa.
36. [x] P1 [UO] Skills: suma real/base/cap i czytelny postęp.
37. [x] P1 [UO] Skills: panel szczegółów z opisem i statystykami.
38. [x] P1 [UO] Skills: przeciąganie aktywnej umiejętności na action bar.
39. [x] P0 [UO] Skills: przycisk użycia tylko dla umiejętności aktywnych.
40. [x] P0 [UO] Skills: wirtualizowana lista i płynny scroll dla pełnego katalogu.
41. [x] P1 [UO] Skills: pełna obsługa klawiatury.
42. [x] P2 [UO] Skills: przełącznik widoku kompaktowego i zaawansowanego.
43. [x] P0 [UO] Crafting: stabilny gump kategorii i receptur zgodny z odpowiedziami serwera.
44. [x] P1 [UO] Crafting: wyszukiwanie i filtrowanie receptur.
45. [x] P1 [N+] Crafting: ulubione receptury zapisywane lokalnie lub na koncie.
46. [x] P1 [N+] Crafting: historia i ostatnio wykonywane receptury.
47. [x] P0 [UO] Crafting: Make Last i ponowienie bez duplikowania requestów.
48. [x] P1 [N+] Crafting: wybór liczby sztuk i bezpieczna kolejka wsadowa.
49. [x] P0 [UO] Crafting: wybór materiału/hue z poprawną walidacją.
50. [x] P0 [UO] Crafting: czytelne wymagania skilli, narzędzi i zasobów.
51. [x] P1 [N+] Crafting: szansa sukcesu i exceptional z danymi autorytatywnymi serwera.
52. [x] P1 [UO] Crafting: podgląd grafiki produktu.
53. [x] P1 [N+] Crafting: podgląd właściwości, jakości i kosztu produktu.
54. [x] P0 [UO] Crafting: wynik sukcesu/błędu bez zamykania i skakania okna.
55. [x] P1 [N+] Crafting: progress i anulowanie bez utraty spójności.
56. [x] P1 [UO] Crafting: czytelne braki zasobów i nazwy reagentów.
57. [x] P1 [UO] Crafting: naprawa, enhance, smelt i imbue w tym samym wzorcu UX.
58. [x] P1 [UO] Crafting: responsywny układ dwóch kolumn ze scrollem.
59. [x] P0 [UO] Trade: dwa jednoznaczne panele stron i właścicieli.
60. [x] P0 [UO] Trade: reset akceptacji po każdej zmianie zawartości.
61. [x] P0 [UO] Trade: niezawodne renderowanie dodania/usunięcia/przeniesienia itemu.
62. [x] P1 [UO] Trade: wyróżnienie ostatnich zmian i konfliktów.
63. [x] P1 [UO] Trade: ilości stosów, ciężar i właściwości itemów.
64. [x] P0 [UO] Trade: czytelny, niepodrabialny stan accepted/pending.
65. [x] P1 [UO] Trade: ostrzeżenia o pustej lub gwałtownie zmienionej ofercie.
66. [x] P0 [UO] Trade: poprawne zamknięcie po anulowaniu, śmierci i rozłączeniu.
67. [x] P1 [UO] Trade: tryb grid/list i dostępne tooltipy.
68. [x] P1 [UO] Trade: obsługa klawiatury i potwierdzenia.
69. [x] P1 [N+] Trade: opcjonalny identyfikator/audyt transakcji bez wpływu na standardowy handel.
70. [x] P2 [N+] Trade: opcjonalny podgląd wyceny serwerowej z wyraźnym oznaczeniem.
71. [x] P0 [UO] Vendor: poprawny wspólny gump kupna i sprzedaży.
72. [x] P1 [UO] Vendor: kategorie oraz wyszukiwanie po nazwie.
73. [x] P0 [UO] Vendor: wirtualizowana lista dużego asortymentu.
74. [x] P0 [UO] Vendor: precyzyjny quantity stepper, wpisanie liczby i Max.
75. [x] P0 [UO] Vendor: autorytatywna suma oraz widoczne dostępne złoto.
76. [x] P0 [UO] Vendor: stan magazynowy i aktualizacja po zakupie.
77. [x] P1 [UO] Vendor: tooltip właściwości i podgląd grafiki.
78. [x] P1 [N+] Vendor: opcjonalne porównanie z założonym przedmiotem.
79. [x] P0 [UO] Vendor: filtr tylko przedmiotów możliwych do sprzedaży.
80. [x] P0 [UO] Vendor: koszyk wybranych pozycji bez gubienia stanu.
81. [x] P0 [UO] Vendor: jednoznaczny rezultat transakcji i częściowego powodzenia.
82. [x] P1 [UO] Vendor: skróty klawiaturowe i szybkie ilości.
83. [x] P0 [UO] Vendor: odporność na zmianę stocku/ceny w trakcie otwarcia.
84. [x] P2 [N+] Vendor: opcjonalne ulubione i historia cen.
85. [x] P0 [UO] Kontenery: poprawny classic/grid, ręczne pozycje, scroll i drag-preview.
86. [x] P0 [UO] Paperdoll: warstwy ekwipunku, mount i odświeżanie bez znikających elementów.
87. [x] P0 [UO] Healthbary: właściwe layouty, targetowanie i aktualizacje życia/śmierci.
88. [x] P0 [UO] Mapa/minimapa: pełne kafle, clipping, markery i responsywny canvas.
89. [x] P0 [UO] Spellbook: zgodne strony, przyciski, drag zaklęć i czytelna typografia.
90. [x] P0 [UO] Action bar: deterministyczne sloty, drag in/out i cooldown na kafelku.
91. [x] P0 [UO] Options: sekcje, poprawne kolumny i walidowane wartości.
92. [x] P1 [UO] Journal/chat: wydajna historia, selekcja tekstu, filtry i czytelność.
93. [x] P1 [UO] Party/guild: spójne listy, statusy i akcje.
94. [x] P1 [UO] Properties/inspector: bezpieczny, kopiowalny i responsywny układ.
95. [x] P1 [UO] House customization: czytelne narzędzia, warstwy i undo lokalnego podglądu.
96. [x] P1 [UO] Quest/BOD/collections: wspólny wzorzec list i postępu.
97. [x] P1 [UO] Books/runebook: strony, nawigacja, edycja i ograniczenia protokołu.
98. [x] P1 [UO] Login/char creation: spójny, dostępny i responsywny flow.
99. [x] P1 [UO] Automatyczny katalog wszystkich gumpów z podglądem stanów.
100. [x] P0 [UO] Bramka jakości: brak overflow, NaN, błędów konsoli i wycieków dla całego katalogu.

## Serwer (100)

1. [x] P0 [UO] Zamrożona zgodność standardowych opcode, długości i semantyki pakietów.
2. [x] P0 [N+] Capability handshake wyłącznie opcjonalny, wersjonowany i ignorowalny.
3. [x] P0 [N+] Każde rozszerzenie ma timeout i fallback do standardowego UO.
4. [x] P0 [UO] Walidacja wszystkich odpowiedzi gumpów: serial, type, button, switch, text.
5. [x] P0 [UO] Limity długości layoutu, tekstów i liczby kontrolek gumpa.
6. [x] P0 [UO] Ochrona przed replay i odpowiedzią do nieaktualnego gumpa.
7. [x] P0 [UO] Deterministyczne zamknięcie/odświeżenie gumpa bez wyścigów.
8. [x] P1 [UO] Wspólny builder gumpów z typowanymi kontrolkami.
9. [x] P1 [UO] Walidator layoutów uruchamiany przy starcie/testach.
10. [x] P1 [UO] Metryki otwarć, odpowiedzi, błędów i czasu życia gumpów.
11. [x] P0 [UO] Skills: kompletna mapa ID i wire-format zgodna z klientami UO.
12. [x] P0 [UO] Skills: autorytatywne locki, capy, base i modyfikatory.
13. [x] P0 [UO] Skills: poprawny gain z cooldownem, difficulty i anti-macro.
14. [x] P0 [UO] Skills: bezpieczne aktywne użycie i target cursor.
15. [x] P1 [UO] Skills: komplet handlerów dla wszystkich zaimplementowanych umiejętności.
16. [x] P1 [UO] Skills: testy parity względem konfiguracji i skryptów.
17. [x] P1 [UO] Skills: centralny pipeline success/failure/message/reveal.
18. [x] P1 [UO] Skills: przerwanie przy ruchu, obrażeniach i zmianie stanu tam, gdzie wymagane.
19. [x] P1 [UO] Skills: telemetryka gainów i wykrywanie anomalii.
20. [x] P2 [N+] Skills: opcjonalne rozszerzone opisy i statystyki treningu.
21. [x] P0 [UO] Crafting: atomowa rezerwacja i konsumpcja zasobów.
22. [x] P0 [UO] Crafting: narzędzie, zasięg, dostęp i durability sprawdzane na commit.
23. [x] P0 [UO] Crafting: serwerowa walidacja skill/material/recipe.
24. [x] P0 [UO] Crafting: poprawny success, exceptional, maker's mark i strata materiału.
25. [x] P0 [UO] Crafting: właściwe hue i warianty materiałowe.
26. [x] P0 [UO] Crafting: transactional Make Last bez podwójnego wykonania.
27. [x] P1 [UO] Crafting: komplet profesji i receptur względem źródeł.
28. [x] P1 [UO] Crafting: repair, smelt, enhance, imbue, unravel i reforge.
29. [x] P1 [UO] Crafting: bonusy talizmanów, runic tools i regionów.
30. [x] P1 [N+] Crafting: opcjonalna, limitowana kolejka batch z anulowaniem.
31. [x] P1 [N+] Crafting: wersjonowany endpoint podglądu szans i właściwości.
32. [x] P0 [UO] Crafting: pełne testy utraty/duplikacji przy disconnect i crash.
33. [x] P1 [UO] Crafting: indeks receptur budowany raz przy starcie.
34. [x] P1 [UO] Crafting: diagnostyka brakujących grafik, nazw i konstruktorów itemów.
35. [x] P2 [N+] Crafting: serwerowe ulubione i historia per konto.
36. [x] P0 [UO] Trade: atomowa sesja z dwoma uczestnikami.
37. [x] P0 [UO] Trade: reset obu akceptacji przy każdej mutacji.
38. [x] P0 [UO] Trade: ownership/parent/range/death walidowane przed commit.
39. [x] P0 [UO] Trade: rollback przy braku miejsca, disconnect i błędzie skryptu.
40. [x] P0 [UO] Trade: blokada duplikacji itemów i golda.
41. [x] P1 [UO] Trade: rate limit i ochrona przed spamem zaproszeń.
42. [x] P1 [UO] Trade: audyt transakcji bez logowania wrażliwych danych.
43. [x] P1 [N+] Trade: opcjonalny identyfikator transakcji dla klienta NodeUO.
44. [x] P0 [UO] Vendor: autorytatywne ceny, ilości i uprawnienia.
45. [x] P0 [UO] Vendor: atomowy zakup z kontrolą golda i pojemności.
46. [x] P0 [UO] Vendor: atomowa sprzedaż i poprawne stackowanie wypłaty.
47. [x] P0 [UO] Vendor: restock, limity i warianty towaru bez duplikatów.
48. [x] P0 [UO] Vendor: poprawne pakiety buy/sell dla obcych klientów.
49. [x] P1 [UO] Vendor: indeks katalogów i wyszukiwanie bez blokowania ticka.
50. [x] P1 [UO] Vendor: player vendors, rental contracts i secure access.
51. [x] P1 [UO] Vendor: BOD, trainer, banker, stablemaster i hair stylist parity.
52. [x] P1 [N+] Vendor: opcjonalne metadane porównania i historii ceny.
53. [x] P0 [UO] Itemy: kompletna semantyka equip layers, container i world parent.
54. [x] P0 [UO] Itemy: atomowy drag/drop/equip/stack/split z rollbackiem.
55. [x] P0 [UO] Itemy: tooltip/property list invalidation po każdej zmianie.
56. [x] P0 [UO] Itemy: weight, capacity, secure containers i accessibility.
57. [x] P1 [UO] Itemy: durability, quality, insurance, blessed/cursed i decay.
58. [x] P1 [UO] Itemy: doors, signs, teleportery i niewidoczne kontrolery świata.
59. [x] P1 [UO] Itemy: houses, multis, boats, addons i deeds parity.
60. [x] P1 [UO] Itemy: corpses, loot rights, carving i decay.
61. [x] P0 [UO] Mobile: poprawne body/hue/animation/corpse mapy.
62. [x] P0 [UO] Mobile: mount/dismount i warstwy ridera bez klonów.
63. [x] P0 [UO] Mobile: movement speed, stamina, weight i mounted state.
64. [x] P0 [UO] Mobile: śmierć, corpse serial i aktualizacja notoriety.
65. [x] P1 [UO] AI: scheduler z budżetem czasu i bez skoków ticka.
66. [x] P1 [UO] AI: perception, pathfinding, combat i return-home.
67. [x] P1 [UO] AI: pet control slots, loyalty, commands i stable.
68. [x] P1 [UO] AI: summon ownership, dispel timer i brak friendly fire właściciela.
69. [x] P1 [UO] AI: region guards i event spawny poza chronionymi miastami.
70. [x] P1 [UO] AI: testy właściwych animacji dla wszystkich body.
71. [x] P0 [UO] Spells: wspólny lifecycle cast–words–target–resolve–effect–cooldown.
72. [x] P0 [UO] Spells: poprawne target type, range, LOS i facet.
73. [x] P0 [UO] Spells: reagenty/mana/scroll/spellbook walidowane na commit.
74. [x] P0 [UO] Spells: teleport/recall/gate z collision i region restrictions.
75. [x] P0 [UO] Spells: summon kontrolowany przez caster i wskazany tile.
76. [x] P1 [UO] Spells: efekty, dźwięki, hue, projectile i timing.
77. [x] P1 [UO] Spells: resist, reflect, protection, interruption i criminal flags.
78. [x] P1 [UO] Spells: Magery/Necro/Chivalry/Bushido/Ninjitsu/Mysticism/Spellweaving/Mastery parity.
79. [x] P1 [UO] Combat: weapon speed, swing timer, hit chance i damage pipeline.
80. [x] P1 [UO] Combat: armor/resists/status effects i buff packets.
81. [x] P0 [UO] World: create-world idempotentny, wersjonowany i walidowany.
82. [x] P0 [UO] World: spawnerzy NPC/mobów/vendorów i kontrola regionów.
83. [x] P0 [UO] World: streaming statików i mobile bez starych seriali.
84. [x] P1 [UO] World: seasons, weather, day/night, light i efekty atmosferyczne.
85. [x] P1 [UO] World: map/statics diffs, multis i navigability audit.
86. [x] P0 [UO] Persistence: spójne snapshoty, journal i odzyskiwanie po crash.
87. [x] P0 [UO] Persistence: migracje schematu z dry-run i rollback planem.
88. [x] P1 [UO] Startup: lazy loading, cache indeksów i profilowanie faz.
89. [x] P1 [UO] Runtime: brak synchronicznego I/O w ticku.
90. [x] P1 [UO] Runtime: backpressure sieci, kolejki i limity pakietów.
91. [x] P0 [UO] Network: parser odporny na fragmentację, sklejenie i nieznane opcode.
92. [x] P0 [UO] Network: differential tests z oficjalnymi/typowymi klientami.
93. [x] P1 [UO] Security: rate limits, ACL komend, sanitizacja i secret hygiene.
94. [x] P1 [UO] Observability: structured logs, traces, tick lag i packet metrics.
95. [x] P1 [UO] Scripts: zero duplikatów rejestracji i deterministyczna kolejność.
96. [x] P1 [UO] Scripts: hot reload w dev z bezpiecznym dispose.
97. [x] P1 [UO] Content: automatyczna macierz parity ze źródłami wzorcowymi.
98. [x] P1 [UO] Commands: spójne katalogi create/item/mobile/mount/multi z podglądem.
99. [x] P1 [UO] Testy: unit/integration/soak/chaos dla krytycznych przepływów.
100. [x] P0 [UO] Bramka jakości serwera: testy, startup audit i zero błędów rejestracji.

## Admin (100)

1. [x] P0 Wspólny design system paneli, formularzy, tabel i dialogów.
2. [x] P0 Czytelna typografia, spacing, kontrast i skala UI.
3. [x] P0 Responsywny układ desktop/tablet bez nachodzenia paneli.
4. [x] P0 Globalna obsługa loading/error/empty/retry.
5. [x] P0 Anulowanie requestów po zmianie widoku i brak stale updates.
6. [x] P1 Dostępność klawiatury, focus i ARIA.
7. [x] P1 Spójne toast notifications i potwierdzenia operacji ryzykownych.
8. [x] P1 Command palette i globalne wyszukiwanie.
9. [x] P1 Zapisywane filtry, kolumny i układy per administrator.
10. [x] P1 Deep links do każdej encji i stanu edytora.
11. [x] P0 RBAC dla ekranów, pól i operacji.
12. [x] P0 Reautoryzacja i CSRF/origin protection dla mutacji.
13. [x] P0 Audit log: kto, co, kiedy, przed/po i correlation ID.
14. [x] P1 Podgląd diff przed zapisem.
15. [x] P1 Undo/redo dla edytorów lokalnych.
16. [x] P1 Optimistic concurrency/ETag i rozwiązywanie konfliktów.
17. [x] P1 Drafty zmian i bezpieczny publish.
18. [x] P1 Walidacja inline z odnośnikiem do błędnego pola.
19. [x] P1 Import/export JSON z walidacją schematu.
20. [x] P1 Bulk edit z preview i raportem częściowych błędów.
21. [x] P0 Mapa ISO: strumieniowanie widocznych chunków zamiast pełnego świata.
22. [x] P0 Mapa ISO: cache LRU kafli i statików z limitem pamięci.
23. [x] P0 Mapa ISO: dekodowanie/indeksowanie w Web Workerze.
24. [x] P0 Mapa ISO: anulowanie renderu po pan/zoom/teleport.
25. [x] P0 Mapa ISO: poprawne culling, z-order i multi/statics.
26. [x] P1 Mapa ISO: płynne pan/zoom, minimapa i koordynaty kursora.
27. [x] P1 Mapa ISO: warstwy terrain/statics/mobiles/spawns/regions/multis.
28. [x] P1 Mapa ISO: filtrowanie warstw, opacity i legendy.
29. [x] P1 Mapa ISO: selection box i wielokrotny wybór.
30. [x] P1 Mapa ISO: brush/erase/fill/eyedropper z preview.
31. [x] P1 Mapa ISO: historia operacji i undo/redo.
32. [x] P1 Mapa ISO: walidacja kolizji, Z i niedostępnych grafik.
33. [x] P1 Mapa ISO: bookmarki lokacji i ostatnie miejsca.
34. [x] P0 Mapa ISO: teleport nie blokuje UI i pokazuje wynik.
35. [x] P1 Mapa ISO: pomiar czasu chunk fetch/decode/draw.
36. [x] P1 Mapa ISO: eksport/import patcha obszaru.
37. [x] P0 Katalog statików z pełnym indeksem, nazwami i grafikami.
38. [x] P1 Katalog statików: kategorie, tagi, wyszukiwanie i ulubione.
39. [x] P1 Katalog statików: virtual grid i progressive thumbnails.
40. [x] P1 Katalog statików: ostatnio używane i warianty hue.
41. [x] P0 Spawnery: poprawne osobne koordynaty i brak nakładania encji.
42. [x] P0 Spawnery: wizualny marker z promieniem i facetem.
43. [x] P1 Spawnery: edycja listy typów, wag i liczebności.
44. [x] P1 Spawnery: min/max delay, team, home range i roaming.
45. [x] P1 Spawnery: aktywacja, harmonogram i warunki regionu.
46. [x] P1 Spawnery: symulacja rozkładu i preview bez zapisu.
47. [x] P1 Spawnery: diagnostyka żywych instancji i respawn.
48. [x] P1 Spawnery: wykrywanie duplikatów i pustych typów.
49. [x] P1 Spawnery: bulk move/enable/disable/delete.
50. [x] P1 Spawnery: szablony vendor/town/dungeon/event.
51. [x] P0 Edytor mobile: body/hue/name/stats/skills/AI z live preview.
52. [x] P1 Edytor mobile: equipment, loot, abilities i resistances.
53. [x] P1 Edytor mobile: mount/rider i animacje wszystkich akcji.
54. [x] P1 Edytor mobile: pet/control slots/loyalty/taming.
55. [x] P0 Edytor itemu: art/hue/layer/amount/weight/flags z preview.
56. [x] P1 Edytor itemu: properties, durability, container i scripts.
57. [x] P1 Edytor itemu: warianty grafiki i wykrywanie brakujących artów.
58. [x] P1 Edytor multi/house/boat/addon z footprintem.
59. [x] P1 Edytor door/sign/teleporter z wizualnym połączeniem.
60. [x] P1 Edytor regionów: geometria, zasady, guards, music i weather.
61. [x] P0 Edytor vendorów: katalog kupna/sprzedaży z cenami i stockiem.
62. [x] P1 Edytor vendorów: kategorie, restock i preview gumpa klienta.
63. [x] P1 Edytor player-vendor/rental contracts.
64. [x] P0 Edytor craftingu: profesje, kategorie i receptury.
65. [x] P1 Edytor craftingu: wymagania, materiały, szanse i rezultat preview.
66. [x] P1 Edytor craftingu: graf zależności receptur i wykrywanie braków.
67. [x] P0 Edytor skilli: ID, nazwy, capy, gain i handler mapping.
68. [x] P1 Edytor skilli: podgląd rozkładu gain chance.
69. [x] P0 Edytor spelli: circle, mana, reagenty, target i efekty.
70. [x] P1 Edytor spelli: wizualny lifecycle oraz test cast sandbox.
71. [x] P1 Edytor combat: bronie, speed, damage, abilities i wymagania.
72. [x] P1 Edytor loot: zagnieżdżone tabele, wagi i symulacja dropów.
73. [x] P1 Edytor questów: graf kroków, warunki, dialog i nagrody.
74. [x] P1 Edytor dialogów/gumpów: wizualny layout z kontrolą overflow.
75. [x] P1 Edytor books/BOD/collections/achievements.
76. [x] P1 Edytor pogody/sezonów/dnia/nocy z live preview.
77. [x] P1 Edytor eventów i scheduler z kalendarzem.
78. [x] P1 Edytor komend: ACL, aliasy, pomoc i wykrywanie duplikatów.
79. [x] P0 Katalog Create: item/mobile/mount/multi z nazwą i podglądem.
80. [x] P1 Katalog Create: kategorie, tagi, ostatnie i ulubione.
81. [x] P0 Live world: bezpieczny teleport, go-to i follow serial.
82. [x] P1 Live world: inspector mobile/item/spawner/region.
83. [x] P1 Live world: log pakietów i zdarzeń filtrowany per serial.
84. [x] P1 Live world: kill/delete/move/hue z potwierdzeniem i audytem.
85. [x] P1 Live world: podgląd online, ping, pozycji i klienta.
86. [x] P1 Dashboard tick lag, event loop, pamięć, GC i kolejki.
87. [x] P1 Dashboard sieci: throughput, opcode, błędy parsera i backpressure.
88. [x] P1 Dashboard skryptów: czas ładowania, błędy i hot reload.
89. [x] P1 Dashboard AI/pathfinding: budżet i najdroższe encje.
90. [x] P1 Dashboard storage: snapshot, journal, save time i rozmiary.
91. [x] P1 Log viewer ze structured filters, correlation i eksportem.
92. [x] P1 Alerty progowe oraz link do diagnostyki.
93. [x] P0 Zarządzanie backupami: lista, verify i kontrolowany restore.
94. [x] P1 Migracje: plan, dry-run, progress i raport.
95. [x] P1 Feature flags i capability rollout per konto/shard.
96. [x] P1 Protocol inspector rozdzielający UO od negocjowanych NodeUO extensions.
97. [x] P1 Automatyczny health check zależności i integralności assetów.
98. [x] P1 Test runner z wyborem suite i czytelnym raportem.
99. [x] P1 Performance budgets dla mapy, tabel i API panelu.
100. [x] P0 Bramka jakości admina: typecheck, testy, E2E, a11y i zero błędów konsoli.
