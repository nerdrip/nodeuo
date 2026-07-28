# Gumpy: serwer, klient i edytor

NodeUO obsługuje trzy rodzaje definicji gumpów. Wszystkie kończą jako standardowe
kontrolki albo pakiety Ultima Online; własny format JSON nie zmienia protokołu UO.

## Model i kompatybilność

| Źródło | Do czego służy | Zachowanie awaryjne |
| --- | --- | --- |
| `data/config/gumps.json` | w pełni data-driven gumpy serwera | rekord JSON jest źródłem layoutu |
| `data/config/server-gump-catalog.json` | katalog gumpów tworzonych w JS | kod JS działa, dopóki override nie ma `enabled: true` |
| `apps/client/public/client-gumps.json` | lokalne layouty i override'y webowego klienta | wbudowana klasa JS działa bez JSON-u lub przy błędzie |

Klient łączący się z ServUO lub innym emulatorem nadal renderuje otrzymany
standardowy layout UO. `client-gumps.json` dotyczy wyłącznie lokalnych okien
klienta, np. paperdolla, opcji i action bara.

## Najprostszy gump serwerowy

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello-gump',
    access: 'Player',
    run(ctx) {
      api.gumps.send(ctx.state, {
        definitionId: 'server:examples:hello-gump',
        x: 100,
        y: 100,
        layout: [
          '{ page 0 }',
          '{ resizepic 0 0 5054 320 150 }',
          '{ text 25 20 1153 0 }',
          '{ textentry 25 55 260 20 1152 1 1 }',
          '{ button 25 105 4023 4024 1 0 1 }',
          '{ button 170 105 4017 4018 1 0 0 }',
        ].join(''),
        texts: ['Jak masz na imię?', ''],
      }, (response) => {
        if (response.buttonId !== 1) return;
        const name = response.textEntries
          .find((entry) => entry.entryId === 1)?.text ?? '';
        ctx.state.sendSystemMessage(`Cześć ${name}!`);
      });
    },
  });
}
```

Odpowiedź zawiera:

```js
{
  serial,        // właściciel / kontekst gumpa
  gumpId,        // identyfikator instancji
  buttonId,      // kliknięty przycisk; 0 zwykle oznacza zamknięcie
  switches,      // zaznaczone radio/checkbox IDs
  textEntries,   // [{ entryId, text }]
}
```

Serwer waliduje odpowiedź względem kontrolek wysłanego gumpa, limituje liczbę
aktywnych okien i usuwa callback po pierwszej poprawnej odpowiedzi. Nie ufaj
mimo to treści z `textEntries`: sprawdzaj długość, zakres i uprawnienia gracza.

## Gump w pełni opisany JSON-em

```json
{
  "definitionId": "daily-reward",
  "name": "Daily reward",
  "x": 110,
  "y": 90,
  "width": 360,
  "height": 220,
  "controls": [
    { "type": "panel", "x": 0, "y": 0, "width": 360, "height": 220, "artId": 5054 },
    { "type": "label", "x": 24, "y": 18, "width": 300, "height": 20, "hue": 1153, "text": "Nagroda dla {{playerName}}" },
    { "type": "image", "x": 24, "y": 55, "width": 64, "height": 64, "artId": 10400 },
    { "type": "button", "x": 24, "y": 165, "width": 30, "height": 24, "normalId": 4023, "pressedId": 4024, "buttonId": 1 },
    { "type": "label", "x": 62, "y": 167, "width": 120, "height": 20, "hue": 1149, "text": "Odbierz" }
  ]
}
```

Teksty `{{name}}` korzystają z `gump.values`. Dla source-linked override'u
dostępne są też `texts` i `original`:

```js
api.gumps.send(ctx.state, {
  definitionId: 'daily-reward',
  values: { playerName: ctx.sender.name },
  layout: fallbackLayout,
  texts: fallbackTexts,
}, onResponse);
```

## Kontrolki JSON

| Typ | Najważniejsze pola |
| --- | --- |
| `panel` | `x`, `y`, `width`, `height`, `artId` |
| `label` | geometria, `text`, `hue` |
| `button` | geometria, `normalId`, `pressedId`, `buttonId`, `quit`, `page` |
| `textentry` | geometria, `entryId`, `text`, `hue` |
| `checkbox` / `radio` | `uncheckedId`, `checkedId`, `switchId`, `checked` |
| `image` | `artId`, opcjonalnie geometria |
| `tilepic` | `artId`, `hue` |
| `html` | geometria, `text`, `background`, `scrollbar` |
| `alpha` | geometria |
| `page` | `page` |

Każdy gump i każda interaktywna kontrolka powinny mieć stabilny identyfikator.
Nie wyliczaj `buttonId` z pozycji rekordu, jeśli kolejność może się zmienić.

## Source-linked gumpy serwera

Skrypt `pnpm catalog:gumps:server` skanuje wywołania `api.gumps.send` i aktualizuje
`server-gump-catalog.json`. Rekord zawiera ścieżkę źródła i linię, dlatego można
przejść z projektanta bezpośrednio do funkcjonalnego JavaScriptu.

```json
{
  "definitionId": "server:commands-example:open-menu",
  "scope": "server",
  "mode": "source-linked",
  "source": "commands/example.js",
  "enabled": false,
  "width": 320,
  "height": 240,
  "controls": []
}
```

`enabled: false` jest bezpiecznym ustawieniem: produkcyjny layout pozostaje w
kodzie. Po odtworzeniu kontrolek w edytorze ustaw `enabled: true`; resolver
zastąpi layout, ale callback i cała logika skryptu pozostaną bez zmian.

## Lokalne gumpy klienta

Każda znaleziona klasa gumpa ma rekord w `client-gumps.json`. Rekord jest
nakładką na działający kod klienta:

```json
{
  "definitionId": "client:action-bar-gump",
  "scope": "client",
  "className": "ActionBarGump",
  "type": "actionbar",
  "source": "action-bar-gump.js",
  "frame": { "enabled": true, "width": 720, "height": 72, "opacity": 1 },
  "behavior": { "enabled": true, "canMove": true, "canClose": true },
  "controlOverrides": [
    { "enabled": true, "controlId": "status-label", "x": 12, "y": 8 }
  ]
}
```

Najstabilniejszym selektorem jest `controlId` nadany kontrolce w konstruktorze
przez `setLayoutId()`. Przetrwa on dodawanie i zmianę kolejności innych elementów.
Starsze gumpy można nadal wskazać przez `className` + `classIndex` albo ścieżką
indeksów dzieci, np. `0.2`.

Plik jest częścią statycznych zasobów klienta. Jeśli fetch zakończy się błędem,
rekord jest błędny albo klient łączy się z obcym serwerem, konstruktor JS nadal
tworzy pełne okno. Dzięki temu edycja wizualna nie jest warunkiem kompatybilności.

## Edycja w Content Studio

1. Wybierz **Gumps & layouts**.
2. `config/gumps.json` edytuje gumpy data-driven.
3. `config/server-gump-catalog.json` pokazuje wszystkie wykryte miejsca wysyłki.
4. `@client/client-gumps.json` edytuje lokalne okna klienta.
5. Przeciągaj kontrolki na scenie, zmieniaj ich rozmiar i używaj pickerów grafiki.
6. Sprawdź ostrzeżenia o overflow, zduplikowanych ID i brakujących polach.
7. Publikacja tworzy backup. Dla klienta potrzebny jest ponowny build/reload strony;
   dla serwera wystarcza hot reload, jeśli zmieniany plik należy do scripts data.

## Reguły bezpieczeństwa i wydajności

- Nie generuj nieograniczonej liczby kontrolek z danych gracza.
- Trzymaj teksty i odpowiedzi w rozsądnych limitach.
- Nie wykonuj akcji tylko dlatego, że przyszedł `buttonId`; ponownie sprawdź ACL.
- Duże gumpy są automatycznie pakowane, ale nadal mają limit rozmiaru pakietu UO.
- Callback jest połączeniowy i krótkotrwały; trwały workflow zapisuj jako dane gracza.
- Dynamiczne listy stronicuj zamiast wysyłać tysiące wierszy.
