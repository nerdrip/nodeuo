# NodeUO Scriptbook

Ten przewodnik opisuje pisanie zawartości dla serwera NodeUO. Kod silnika żyje
w `apps/server/src`, natomiast reguły świata, komendy, przedmioty, mobile, AI,
czary, questy i wydarzenia powinny trafiać do `apps/scripts/src`.

> Najważniejsza zasada: skrypt korzysta z publicznego `api`, nie importuje
> prywatnych modułów silnika. Dzięki temu działa po hot reloadzie, jest prostszy
> do testowania i nie omija indeksów świata.

## Pierwszy skrypt

Najmniejszy moduł eksportuje funkcję rejestrującą zawartość:

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello',
    access: 'Player',
    help: '[hello',
    run(ctx) {
      ctx.state.sendSystemMessage(`Witaj ${ctx.sender.name}!`);
    },
  });
}
```

Do modułów składających się głównie z komend, eventów i timerów wygodny jest
`defineScript`:

```js
import { defineScript } from './_script.js';

export default defineScript({
  commands: [{
    name: 'ping',
    access: 'Player',
    run: (ctx) => ctx.state.sendSystemMessage('pong'),
  }],
  events: {
    'scripts:reloaded': (_event, api) => api.log('scripts ready'),
  },
  intervals: [{ every: 60_000, run: (api) => api.log('minute tick') }],
});
```

## Gdzie dodać funkcję

| Funkcja | Kanoniczne miejsce |
| --- | --- |
| Komenda | `apps/scripts/src/commands/` |
| Definicja przedmiotu | `data/config/items.json` |
| Zachowanie przedmiotu | `items/scripts/` albo `items/behaviors/` |
| Mobile lub NPC | `data/config/monsters.json`, `npcs.json` |
| AI | `apps/scripts/src/npcs/ai/` |
| Czar | `data/config/spells.json` + `apps/scripts/src/spells/` |
| Skill | `data/config/skills.json` + `apps/scripts/src/skills/` |
| Crafting | `data/config/recipes.json` + `apps/scripts/src/crafting/` |
| Spawn lub świat | `data/world/` + `apps/scripts/src/spawns/` |
| Gump | `data/config/gumps.json` albo kod korzystający z `api.gumps` |

## Publiczne warstwy API

| API | Zastosowanie |
| --- | --- |
| `api.game` | tworzenie, ruch, ekwipunek, indeksowane wyszukiwanie |
| `api.lifecycle` | komendy, eventy i timery sprzątane przy reloadzie |
| `api.systems` | domeny silnika: czary, combat, housing, questy itd. |
| `api.gumps` | standardowe gumpy protokołu UO |
| `api.targeting` | wybór celu przez klienta |
| `api.itemScripts` | lifecycle i używanie przedmiotów |
| `api.templates` | szablony przedmiotów |
| `api.protocol` | standardowe pakiety klienta UO |
| `api.game.*Near` | szybkie zapytania przestrzenne |

`api.world` jest wyjściem awaryjnym dla migracji, administracji i rzadkich
globalnych raportów. Nie używaj pełnego skanowania świata w tickach AI.

## Workflow w panelu Admin

1. Otwórz **Content Studio** i wybierz domenę, np. Items, Mobiles albo Spells.
2. Edytuj rekord oraz — jeśli jest powiązany — otwórz jego skrypt przyciskiem
   **Edit bound script**.
3. Użyj walidacji i podglądu diff.
4. Publikacja tworzy backup i wykonuje hot reload skryptów.
5. Dla zmian silnika uruchom ponownie serwer; dla większości zmian zawartości
   wystarcza reload.

## Reguły hot reloadu

- używaj `api.lifecycle.setInterval`, a nie surowego `setInterval`;
- używaj `api.lifecycle.event`, aby subskrypcja została usunięta;
- rejestruj komendy przez `api.lifecycle.command`;
- przechowuj seriale encji, nie obiekty runtime;
- ręczne rejestracje muszą zwracać disposer.

## Minimalna walidacja

```powershell
pnpm --filter @uo/server test
```

Zmiany klient–serwer albo protokołu wymagają dodatkowo smoke testów klienta.
Rozszerzenia NodeUO muszą pozostać negocjowane; standardowy protokół Ultimy
nie może zmieniać zachowania dla innych emulatorów.

