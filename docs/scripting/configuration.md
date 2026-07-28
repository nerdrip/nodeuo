# Konfiguracje i dane świata

JSON-y w `apps/scripts/src/data` dzielą się na konfigurację typów oraz fakty
umieszczane w świecie. Ten podział decyduje, czy wystarczy reload, czy trzeba
ponownie wygenerować zawartość świata.

## Config kontra world

| Rodzaj | Katalog | Znaczenie |
| --- | --- | --- |
| Config | `data/config/` | czym jest item, mobile, czar, skill, loot albo recepta |
| World | `data/world/` | gdzie coś stoi, co spawnuje i jak przebiega quest/event |

Zmiana configu wpływa na nowe instancje i systemy czytające definicję na żywo.
Nie musi przepisać już istniejącego przedmiotu. Zmiana danych świata nie usuwa
automatycznie poprzednio postawionych obiektów.

## Tożsamość przedmiotu

Nie mieszaj stabilnej definicji z grafiką:

```json
{
  "definitionId": "golden-hunt-ticket",
  "artId": 5359,
  "name": "golden hunt ticket",
  "hue": 2213,
  "weight": 1,
  "script": "golden-hunt-ticket"
}
```

- `definitionId` identyfikuje gameplay i zapis; musi być stabilny i unikalny.
- `artId`/`itemId` wskazuje grafikę Ultimy. Wiele definicji może używać tej samej.
- `name` jest nazwą wyświetlaną.
- `hue` zmienia paletę bez zmiany grafiki.
- `script` wiąże lifecycle przedmiotu.

Zmiana `definitionId` istniejącej treści jest migracją danych. Zmiana `artId`
jest tylko zmianą wyglądu, o ile skrypt nie opiera się błędnie na grafice.

## Mobile i AI

```json
{
  "kind": "ember-wolf",
  "name": "an ember wolf",
  "body": 225,
  "hue": 1259,
  "hp": 180,
  "str": 220,
  "dex": 140,
  "int": 60,
  "dmgMin": 8,
  "dmgMax": 14,
  "ai": "predator",
  "loot": "fire-creature"
}
```

`kind` jest stabilną definicją, a `body` tylko identyfikatorem animacji/grafiki.
AI powinno wskazywać nazwę z katalogu `npcs/ai`. Nie kopiuj implementacji AI
do JSON-u; JSON przechowuje wybór i parametry, JS zachowanie.

## Czary

```json
{
  "id": 17,
  "name": "Fireball",
  "school": "magery",
  "circle": 3,
  "skillId": 25,
  "minSkill": 300,
  "mana": 9,
  "delayMs": 1000,
  "requiresTarget": true,
  "reagents": ["Black Pearl"],
  "script": "magery/circle3/fireball.js"
}
```

Metadane castowania są w `spells.json`, a efekt w module `spells/`. Content
Studio pozwala otworzyć przypisany skrypt, wybrać inny moduł i uruchomić
walidację cast lifecycle bez wykonywania czaru w świecie.

## Najważniejsze pliki config

| Plik | Odpowiedzialność |
| --- | --- |
| `items.json` | definicje itemów, grafika, layer, waga, skrypt |
| `item-types.json` | tagi i rodziny itemów |
| `monsters.json` | potwory, zwierzęta, bossowie, tameables |
| `npcs.json` | archetypy NPC, vendorzy i mieszkańcy |
| `skills.json` | kanoniczne ID i metadane umiejętności |
| `spells.json` | czary wszystkich szkół i powiązane moduły |
| `recipes.json` | wymagania, materiały i rezultaty craftingu |
| `loot-tables.json` | nazwane tabele dropu |
| `vendor-inventory.json` | stock, ceny i restock sprzedawców |
| `gumps.json` | gumpy serwera opisane wizualnie |

## Najważniejsze dane świata

| Plik | Odpowiedzialność |
| --- | --- |
| `decorations.json` | dekoracje mapy |
| `signs.json` | znaki i etykiety miast |
| `teleporters.json` | przejścia między lokacjami/facetami |
| `regional-npcs.json` | nazwani NPC w konkretnych miejscach |
| `xmlspawners.json` | grupy i prostokąty spawnu |
| `quest-chains.json` | kroki, warunki i nagrody questów |
| `seasonal-events.json` | okna i ustawienia wydarzeń |

## Publikowanie

- Content Studio wykonuje walidację, diff, backup i bezpieczny zapis.
- Raw Data Editor służy do plików, które nie mają jeszcze specjalizowanego UI.
- Nie edytuj wygenerowanych plików, jeśli nagłówek wskazuje generator.
- Po zmianie katalogu gumpów uruchom odpowiedni generator zamiast ręcznie
  dopisywać wykrywane rekordy.
- Przed zmianą world data zrób snapshot. `wipeworld` jest operacją destrukcyjną.

