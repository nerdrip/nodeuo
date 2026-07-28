# Wzorce i kompletne przykłady

Poniższe przykłady pokazują preferowane granice API. Są celowo małe — logikę
domenową należy składać z helperów, zamiast rozbudowywać jeden globalny skrypt.

## Item lifecycle

Definicja w `items.json`:

```json
{
  "definitionId": "daily-coin-token",
  "artId": 5360,
  "name": "daily coin token",
  "weight": 1,
  "script": "daily-coin-token"
}
```

Implementacja:

```js
export default function register(api) {
  api.itemScripts.register({
    name: 'daily-coin-token',
    onUse({ item, user, state }) {
      const player = api.game.mobileRef(user);
      const reward = player?.giveItem({
        definitionId: 'gold',
        artId: 0x0EED,
        amount: 250,
        name: 'gold',
      }, { randomGrid: true });

      if (!reward) return state?.sendSystemMessage?.('Potrzebujesz plecaka.');
      api.game.item.destroy(item);
      state?.sendSystemMessage?.('Nagroda odebrana.');
    },
  });

  return () => api.itemScripts.unregister('daily-coin-token');
}
```

## Targetowanie i teleport

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'blink',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Wskaż miejsce.');
      api.targeting.request(ctx.state, (target) => {
          if (!target) return;
          api.game.mobile.teleport(ctx.sender, {
            x: target.x,
            y: target.y,
            z: target.z,
            map: target.map ?? ctx.sender.map,
          }, { state: ctx.state, refresh: true });
      }, { allowGround: true });
    },
  });
}
```

Sygnatura to `api.targeting.request(state, callback, options)`. Target zawsze
ponownie waliduj po stronie serwera.

## Bezpieczny timer wydarzenia

```js
import { defineScript } from './_script.js';

export default defineScript({
  intervals: [{
    every: 30_000,
    run(api) {
      for (const player of api.game.onlineMobiles()) {
        if (!player._eventParticipant) continue;
        player._eventSeconds = (player._eventSeconds ?? 0) + 30;
      }
    },
  }],
});
```

Timer zostanie usunięty podczas hot reloadu. Nie trzymaj w closure obiektów
mobile przez wiele minut; jeżeli potrzebujesz trwałej referencji, zachowaj serial.

## Indeksowane zapytania

```js
const enemies = api.game.mobilesNear(caster, { range: 8, self: caster })
  .filter((mobile) => api.systems.combat?.canAttack?.(caster, mobile));

for (const enemy of enemies) {
  api.systems.combat?.damage?.(enemy, 10, caster, { type: 'fire' });
}
```

Nie skanuj `api.world.mobiles.values()` dla każdego castu lub ticka AI.

## Komenda administratora z ACL

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'event-status',
    access: 'GameMaster',
    help: '[event-status',
    run(ctx) {
      const online = api.game.onlineCount();
      ctx.state.sendSystemMessage(`Online: ${online}`);
    },
  });
}
```

Uprawnienie komendy jest sprawdzane przez registry. Operacje mutujące świat
powinny dodatkowo walidować cel, region i aktualny stan encji.

## Checklist przed publikacją

- publiczne API zamiast prywatnego importu z silnika;
- lifecycle/disposer dla każdej rejestracji;
- `definitionId` oddzielone od `artId` i `body`;
- serializowalne dane bez socketów, timerów i funkcji;
- indeksowane zapytania przestrzenne i inventory;
- ACL i ponowna walidacja targetu/odpowiedzi gumpa;
- test regresyjny dla inventory, persistence, targetowania albo protokołu;
- pełny test serwera przed publikacją większej zmiany.
