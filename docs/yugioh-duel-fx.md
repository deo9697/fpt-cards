# Effetti visivi del duello (stile Neon FPT)

Scelto il 18 novembre 2026 dall'artifact "Effetti duello FPT", variante A. Il modulo è **solo presentazione**: non conosce le regole e non decide niente. Il simulatore lo chiama quando il suo motore ha già stabilito cosa succede.

- Codice: `js/games/yugioh/simulator-fx.js`
- Stile: `css/yugioh-simulator-fx.css` (tutte le classi iniziano con `dfx-`)
- Prova: `npm run test:yugioh-fx`, che apre `scripts/fixtures/yugioh-fx-harness.html` in Chrome

## Come agganciarlo

```js
import { createDuelFx } from './simulator-fx.js';

const fx = createDuelFx(fieldElement);   // il contenitore del campo (diventa position:relative)
```

Il CSS va caricato insieme a `css/yugioh-simulator.css`. Il livello degli effetti sta sopra il campo (`z-index: 650`) e lascia passare i tocchi, tranne mentre è aperto un menu o il pannello di scelta.

Il livello va creato una sola volta e **non deve stare dentro l'HTML che il simulatore ridisegna**, altrimenti un ridisegno a metà animazione la cancella. Se il campo viene rimontato, chiama `fx.destroy()` e crea un nuovo `createDuelFx`.

### Fasi

```js
await fx.phase('battle', { turn: 3, player: 'Daniele' });
```

Le fasi disponibili sono `draw`, `standby`, `main1`, `battle`, `main2`, `end`, `your-turn` e `opponent-turn`.

### Evocazioni

```js
await fx.summon({ type: 'synchro', level: 8, image, name });
await fx.summon({ type: 'xyz', rank: 4, materials: 2, image, name });
await fx.summon({ type: 'link', link: 3, markers: ['top', 'bottom-left', 'bottom-right'], image, name });
await fx.summon({ type: 'fusion', image, name });
```

I tipi disponibili sono `normal`, `tribute`, `set`, `special`, `synchro`, `xyz`, `link`, `fusion`, `ritual` e `pendulum`.

Le direzioni Link possibili sono `top`, `top-right`, `right`, `bottom-right`, `bottom`, `bottom-left`, `left` e `top-left`.

Ogni chiamata restituisce una Promise che si risolve a fine effetto, tra 0,9 e 3,6 secondi. Un nuovo effetto interrompe quello in corso e ne risolve la Promise, quindi nessun `await` resta appeso.

### Menu azioni su una carta

```js
const id = await fx.actionMenu({
  anchor: cardElement,
  actions: [
    { id: 'summon', label: 'Evoca / Posiziona', hint: 'Mano' },
    { id: 'effect', label: 'Attiva effetto', disabled: true, reason: 'Già usato in questo turno' },
    { id: 'attack', label: 'Attacca', hint: 'Battle' },
  ],
}); // → 'summon' | 'effect' | 'attack' | null (Annulla)
```

"Annulla" viene aggiunto sempre. Le voci disponibili e i motivi li decide il simulatore.

### Scelta dell'evocazione

```js
const pick = await fx.chooseSummon({
  image, name, level: 8, atk: 3000, def: 2500,
  note: 'Livello 8: servono 2 tributi.',
  options: [
    { id: 'normal', label: 'Evocazione Normale', hint: '2 tributi', note: 'Scegli 2 mostri da offrire' },
    { id: 'set', label: 'Posiziona coperta', hint: '2 tributi', needsPosition: false },
    { id: 'special', label: 'Evocazione Speciale', hint: 'effetto', disabled: true, reason: 'Nessun effetto lo permette ora' },
  ],
}); // → { method: 'normal' | 'set' | 'special', position: 'attack' | 'defense' | null } oppure null
```

La scelta dei tributi resta al simulatore: dopo `pick`, è lui a evidenziare i mostri selezionabili.

## Prestazioni

- Animazioni solo con `transform`, `opacity` e gradienti, senza `backdrop-filter`. Il livello usa `contain: layout paint`.
- Con "riduci animazioni" del telefono ogni effetto dura un istante, e le Promise si risolvono subito (circa 60 ms).
- Un solo effetto alla volta, con nodi creati al momento e rimossi alla fine: nessun timer o listener resta attivo.

## Note sul simulatore (lato browser, da valutare)

Emerse dall'analisi del 18 novembre 2026. Non sono state modificate: i file sono in lavorazione in un'altra sessione.

1. Il campo viene ridisegnato per intero (innerHTML) a ogni aggiornamento di stato. Aggiornare solo le zone cambiate ridurrebbe il lavoro per mossa.
2. `.ygo-overlay` usa `backdrop-filter: blur(5px)` a schermo intero, molto costoso sui telefoni: meglio un fondo semitrasparente pieno.
3. `ygo-target-pulse` anima `box-shadow`, quindi ogni bersaglio valido si ridisegna a ogni fotogramma. Meglio animare l'opacità di un alone (`::after`).
4. I listener `touchmove`/`pointermove` non passivi sul documento sono sempre attivi. Si potrebbero aggiungere solo durante il trascinamento.
