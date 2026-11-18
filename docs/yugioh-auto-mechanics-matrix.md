# Matrice di verifica del simulatore automatico Yu-Gi-Oh!

Audit locale del 17 novembre 2026, esteso il 18 novembre a effetti fuori campo e Testa mazzo, profilo **TCG Advanced / Master Rule 2020**. Questa matrice distingue meccaniche eseguite realmente, controlli del protocollo e casi ancora non esercitati. Non costituisce una certificazione di tutte le singole carte o delle loro combinazioni.

Il gioco è deciso da `ocgcore-wasm@0.1.6` con `MODE_MR5`, `TCG_SEGOC_NONPUBLIC` e `TCG_SEGOC_FIRSTTRIGGER`, usando gli script Lua fissati nel manifest. Il profilo `ignis-14f3b8905ff9-babel-6e21009855ed-tcg-r3` applica tre correzioni mirate agli effetti. La banlist è `tcg-2026-10-19`, verificata il 17 novembre. Il validatore esclude le voci fuori dal formato TCG.

## Metodo

Le prove di gioco creano mazzi validi da 40 carte e passano esclusivamente scelte autorizzate a `createAutoState` / `applyAutoInput`. Un seed ordinario permette aperture ripetibili. Non vengono modificati campo, LP, mano, Cimitero o materiali; non vengono aggiunti script di prova o attivati flag di duello semplificato. Le condizioni di preparazione, i costi e gli esiti vengono prodotti dal motore reale. I test del servizio e della UI usano invece dati sintetici dove indicato, senza account o notifiche reali.

Legenda prove:

- **Core**: [yugioh-auto-core-smoke.mjs](../scripts/yugioh-auto-core-smoke.mjs).
- **Advanced**: [yugioh-auto-advanced-smoke.mjs](../scripts/yugioh-auto-advanced-smoke.mjs).
- **Mechanics**: [yugioh-auto-mechanics-smoke.mjs](../scripts/yugioh-auto-mechanics-smoke.mjs), 19 gruppi di scenari reali.
- **Events**: [yugioh-auto-state-events-smoke.mjs](../scripts/yugioh-auto-state-events-smoke.mjs).
- **Protocol live**: [yugioh-auto-protocol-live-smoke.mjs](../scripts/yugioh-auto-protocol-live-smoke.mjs).

## Regole ed effetti eseguiti realmente

Tutte le righe seguenti hanno superato le rispettive prove locali.

| Famiglia | Scenario reale e comportamento atteso verificato | Prova |
|---|---|---|
| Turni e pescata | Cinque carte iniziali; chi inizia non pesca e non può entrare nella prima Battle Phase; pescata automatica del secondo giocatore | Core, Mechanics |
| Normal Summon / Set | Un'unica quota condivisa; secondo Normal Summon e secondo Set non vengono proposti; Double Summon aumenta la quota | Mechanics |
| Tributi | Summoned Skull richiede un mostro; Dark Magician non è evocabile con un solo tributo e ne consuma due | Mechanics |
| Flip e posizione | Un mostro settato non può essere scoperto nello stesso turno; Flip Summon nel turno seguente; nessun secondo cambio posizione nel turno; quota ripristinata | Mechanics |
| Posizione di Evocazione Speciale | Monster Reborn consente Difesa e la conserva per entrambi i partecipanti; un Link resta in Attacco e non offre cambi in Difesa | Core, Advanced, Mechanics |
| Ritual | Black Illusion Ritual richiede Relinquished, consuma un vero mostro dalla mano e manda il Rito al Cimitero; senza il Ritual Monster non è attivabile | Mechanics |
| Materiali alternativi con Spirit Elimination | Dogmatikamacabre evoca White Relic con un tributo dalla mano. Spore può bandire Lonefire Blossom da una Zona Mostri Main occupata, prendere il suo posto e salire al Livello 4 | `yugioh-auto-effect-conditions-smoke.mjs` |
| Famiglie LV | Dopo due Level Up!, Level Down!? riconosce Horus LV8, lo rimette nel Deck ed evoca Horus LV6 dal Cimitero | Effect conditions |
| Fusion | Polymerization seleziona i materiali nominati dalla mano e li manda al Cimitero; con un materiale sbagliato non è attivabile | Advanced, Mechanics |
| Contact Fusion / nome modificato | Proto-Cyber Dragon assume il nome richiesto sul terreno; con Cyber Phoenix permette Chimeratech Fortress Dragon, senza Polymerization, con 2000 ATK da due materiali reali | Mechanics |
| Synchro | Tuner e Livelli corretti permettono l'evocazione; due non-Tuner con somma corretta e Tuner con somma sbagliata vengono rifiutati | Advanced, Mechanics |
| Livello alternativo per materiali | Tuningware viene usato con il valore alternativo previsto dalla sua procedura Synchro reale | Protocol live |
| Xyz | Rank 4 richiede Livelli compatibili; Livelli 4 e 3 non lo permettono; i materiali rimangono attaccati, e Gagaga Cowboy stacca un materiale come costo e infligge 800 | Advanced, Mechanics |
| Materiali avversari e Xyz coperto | Dugg Charger sceglie un materiale avversario distinto e lo manda al Cimitero del proprietario. Dopo Book of Moon il mostro resta privato, mentre i suoi materiali pubblici rimangono leggibili e selezionabili | Protocol live, UI |
| Link | Link Spider richiede un Normal Monster; Breaker non soddisfa il requisito; materiale al Cimitero, Link Rating/freccia e Zona Mostri Extra corretti | Advanced, Mechanics |
| Pendulum dalla mano | Scale nelle due zone esterne; Livelli uguali alle Scale esclusi; selezione multipla; una sola Pendulum Summon per turno | Advanced, Mechanics |
| Pendulum scoperto dall'Extra | Senza Link può entrare soltanto in una Zona Mostri Extra; con Link Spider nella Zona Extra entra soltanto nella Main Monster Zone indicata dalla freccia | Mechanics |
| Destinazione Pendulum | Un Pendulum usato come materiale Link o distrutto sul terreno va scoperto nell'Extra Deck | Mechanics, Events |
| Normal Spell settata | Upstart Goblin si può attivare nello stesso turno del Set e produce pescata e recupero LP reali | Mechanics |
| Quick-Play e Trap settate | Rush Recklessly e Compulsory non si attivano nel turno del loro Set; Rush risponde nel turno seguente; MST dalla mano non è disponibile nel turno avversario | Mechanics |
| Spell Speed e Counter Trap | Solemn Judgment crea Chain 2, paga metà LP, nega Raigeki e preserva il mostro; una Quick-Play non può rispondere a una Counter Trap ancora irrisolta | Core, Mechanics |
| Risoluzione LIFO | Rush Recklessly in Chain 2 si risolve prima di Raigeki in Chain 1, senza un risultato manuale | Mechanics |
| Trigger simultanei obbligatori | Sangan e Witch of the Black Forest distrutti insieme consentono di scegliere l'ordine degli effetti obbligatori; entrambe le ricerche si risolvono | Mechanics |
| Soft once per turn e durata | Card Trooper paga tre carte del Deck, sale a 1900 ATK, non si riattiva nello stesso turno, torna a 400 all'End Phase e recupera l'attivazione nel turno seguente | Mechanics |
| Hard once per turn | Dopo la prima Ash Blossom, una seconda copia in mano non può rispondere a un'altra pescata nello stesso turno | Mechanics |
| Procedura Speciale e risorsa TCG corretta | Red-Eyes Darkness Metal Dragon bandisce realmente un Drago scoperto come costo; la seconda copia non riusa la procedura nello stesso turno; l'effetto evoca un Drago dalla mano e non si riattiva | Mechanics |
| Rimozione e resurrezione | Raigeki distrugge realmente; Monster Reborn propone bersagli legali e li trasferisce dal Cimitero al campo | Core |
| Bersaglio coperto e danno standard | Il difensore resta privato prima del Damage Step; combattimento e distruzione sono automatici; nessun danno perforante senza effetto | Advanced |
| Perforante | Spear Dragon infligge 1100 contro 7 Colored Fish in Difesa e poi cambia da solo in Difesa | Mechanics |
| Protezione e Flip in battaglia | Marshmallon non viene distrutto e infligge 1000 all'attaccante dopo essere stato attaccato coperto | Mechanics |
| Attacchi multipli | Hayabusa Knight infligge due attacchi diretti da 1000 e non può attaccare una terza volta | Mechanics |
| Replay dell'attacco | Compulsory rimanda in mano il difensore durante la catena; il core chiede se proseguire e il nuovo attacco diretto infligge 2000 | Mechanics |
| Zone disabilitate | Ground Collapse fa scegliere due Main Monster Zones; le zone disabilitate scompaiono dalle successive scelte legali di posizionamento | Mechanics |
| Token | Scapegoat crea quattro Token con statistiche/posizioni reali, applica la restrizione alle evocazioni e i Token rimossi scompaiono | Events |
| Controllore e proprietario | Mind Control restituisce il controllo all'End Phase; una carta rubata distrutta va nel Cimitero del proprietario originale | Events, Protocol live |
| Equip e relazioni persistenti | Axe of Despair modifica ATK e relazione Equip; distruggerla annulla il bonus e la relazione; Call of the Haunted conserva e poi rimuove il bersaglio | Events, Protocol live |
| Segnalini | Breaker guadagna il segnalino e il bonus ATK; la distribuzione di costi fra più carte rimuove i quantitativi richiesti dal core | Advanced, Protocol live |
| Dadi e monete | Graceful Dice e Cup of Ace producono risultati pubblici reali e replay identici, applicando il relativo effetto | Events |
| Rivelazioni e memoria privata | Exchange permette la scelta delle mani appena rivelate; Duality rivela gli scavi; Eye of Truth rende pubblica la mano finché resta attiva, poi la copre | Advanced, Events |
| Deck rovesciato | Convulsion of Nature espone soltanto la carta superiore; pescata e rimozione dell'effetto aggiornano/ripristinano la privacy | Events |
| Banish e ritardi | Pot of Desires paga dieci carte coperte senza rivelarle; Gold Sarcophagus bandisce scoperto e aggiunge dopo due Standby Phase | Events |
| Fine turno e vittoria | Scarto obbligatorio fino a sei; deck-out senza danno LP; cinque pezzi di Exodia; sconfitta per LP a zero senza prompt residuo | Advanced, Events |
| Vittoria nella mano iniziale | Exodia generato dal core reale attraversa invito/accettazione e chiude subito il tavolo. Ready, resa o cancellazione non sovrascrivono il risultato; i vecchi tavoli conclusi restano consultabili anche dopo la scadenza | Service, Events |

## Protocollo delle decisioni

Sono verificate tutte le 21 famiglie decisionali del core fissato. L’oracolo sintetico include anche 6.204 piccoli vettori di somma confrontati con le regole C++ di quella revisione, inclusi contributi alti con segno e obiettivo zero; il test del protocollo contiene complessivamente 6.338 assert. Questi confronti non vengono presentati come partite con carte reali.

Il test [yugioh-auto-prompts-smoke.mjs](../scripts/yugioh-auto-prompts-smoke.mjs) verifica tutte le famiglie decisionali implementate e rifiuta risposte fuori dalle scelte, quantità, contributi o maschere ammesse. Queste verifiche sintetiche sono distinte dagli scenari reali:

| Decisione | Evidenza dal core reale |
|---|---|
| Idle, Battle, Effect Yes/No, Option, Card, Unselect, Chain, Position, Place, Tribute | Scenari Core / Advanced / Mechanics / Protocol live |
| Yes/No distinto da Effect Yes/No | Replay con Compulsory: asserzione sul vero `SELECT_YESNO` |
| Disfield | Ground Collapse: vero `SELECT_DISFIELD` e successiva esclusione delle zone |
| Somma esatta | Void Feast evoca i materiali di Livello totale esatto, con costo Spell separato |
| Somma minima almeno pari | Machina Fortress usa i contributi necessari e rifiuta materiali superflui |
| Segnalini distribuiti | Magical Exemplar / Magia: selezione globale e consumo dei quantitativi corretti |
| Ordinamento carte | SPYRAL Drone: il successivo pescare conferma l'ordine scelto |
| Dichiarazione nome, numero, Tipo, Attributo | Prohibition con ricerca filtrata; Reasoning; Hunter with 7 Weapons; DNA Transplant |
| Sasso/carta/forbici per entrambi | Transmission Gear durante il combattimento, con esito e banish reali |
| Ordinamento trigger | Sangan + Witch usano il percorso moderno con `SELECT_CHAIN` obbligatorio; il vecchio messaggio `SORT_CHAIN` è coperto dal test del protocollo ma non è stato emesso in questo scenario |

Le varianti di `SELECT_SUM` con lista obbligatoria o contributi alternativi hanno controlli sintetici dedicati. Lo scenario Tuningware conferma il valore alternativo nella meccanica Synchro moderna, che passa però dalla selezione iterativa: non è una prova reale di ogni variante binaria del vecchio selector di somma.

## Applicazione, privacy e ripristino

| Area | Verifica | Evidenza |
|---|---|---|
| Mazzi TCG | Main 40–60; Extra/Side fino a 15; copie condivise e alias; banlist; Token, Rush e carte non pubblicate nel TCG rifiutate; script obbligatori | `yugioh-auto-deck-rules-smoke.mjs` |
| Inizializzazione del catalogo | Tutte le 14.216 voci standard pubblicate nel TCG, incluse le Forbidden per questa sola prova di compatibilità, vengono inizializzate dal core senza errori Lua; ciò verifica compilazione/inizializzazione e non l'esecuzione di ogni effetto | `yugioh-auto-catalog-smoke.mjs` |
| Stato privato | Seed, mazzi iniziali, transcript e messaggi grezzi non raggiungono il browser; bersagli coperti restano identificati soltanto da coordinate | Core, Events, test protocollo |
| Replay | JSON round-trip, seme e input riproducono le stesse decisioni, statistiche, risultati casuali e viste | Core, Events |
| Versioni e integrità | Risorsa/core incompatibili rifiutati; byte alterati in una copia isolata degli archivi rifiutati | Events, catalog smoke |
| Worker | Timeout effettivo senza salvataggio parziale; nuovo worker può ripetere la mossa; nessuna dipendenza da RAM persistente | Events |
| Servizio | Invito privato, due conferme, appartenenza corrente al team, azioni solo del motore, CAS, idempotenza, ricerca autorizzata, resa e risultato automatico | `yugioh-auto-service-smoke.mjs` (runtime sintetico) |
| Interazione mobile | Due contesti Chrome con servizio e worker reali; tocco/menu compatto, pressione per sola descrizione, conferma zone, catene e risposta, sincronizzazione | `yugioh-auto-browser-smoke.mjs` |
| Geometria mobile | 844×390 e 740×360; gate verticale; uscita fullscreen; Spell/Trap verticali e Mostri in Difesa orizzontali; nessun errore console o risorsa mancante nella prova | Browser + Core |
| Compatibilità | Tavoli manuali e Testa mazzo conservano il proprio percorso | `test:yugioh-simulator` |
| Distribuzione | Worker, WASM e archivi necessari inclusi nel pacchetto server; risorse private escluse dal precache PWA | `yugioh-auto-packaging-smoke.mjs` |

Le immagini e i resoconti browser sono in `artifacts/yugioh-auto/`. Questi test usano viewport e touch emulati in Chrome: non sostituiscono una prova su ogni modello Android, iPhone o versione del browser.

## Confine della verifica

### Estensione: effetti fuori campo e prova personale

| Area | Prova concreta | Test |
|---|---|---|
| Cimitero | Mezuki paga il banish anche se Crow rimuove il bersaglio; Plaguespreader paga il ritorno in cima e viene bandito; Wulf/Felis distinguono la causa dell'invio; Breakthrough rispetta il turno d'invio; Lost Wind si setta e poi si bandisce; Necro Gardna risponde nel turno avversario | `yugioh-auto-graveyard-smoke.mjs` |
| Blocchi e sostituzioni | Necrovalley impedisce costi/movimenti dal Cimitero finché applicabile; Macro Cosmos sostituisce l'invio e impedisce trigger esclusivamente dal Cimitero | Graveyard |
| Banish, mano e limiti | Giant Rex scoperto/coperto; limite condiviso Thunder Dragondark; Veiler in Chain 2 e restrizione del turno; Zephyros una volta per duello; Grapha con procedura dal Cimitero senza catena | `yugioh-auto-offfield-smoke.mjs` |
| Materiali | Sangan staccato non conta come inviato dal terreno; Trick Clown staccato attiva il trigger e paga 1000; il selector Dugg distingue ogni materiale dal genitore Xyz anche con il giocatore 1 come primo | Offfield, `yugioh-auto-zone-visibility-smoke.mjs` |
| Presentazione effetti fuori campo | Prompt sul proprietario corretto, fonte esatta, artwork pubblico di catena e rivelazione condiviso; materiali con coordinate e indice overlay | Zone visibility, UI |
| Prova personale | Stesso worker/core, risposte passive persistite, isolamento dell'owner, CAS/idempotenza, ripresa/riavvio, tabella privata con RLS e divieti client | `yugioh-auto-passive-smoke.mjs`, `yugioh-auto-practice-service-smoke.mjs`, `yugioh-auto-practice-schema-smoke.mjs` |
| Percorso su telefono | Browser → handler autenticato → servizio personale → worker reale: Foolish manda Zephyros al Cimitero, attivazione dalla galleria, costo/evocazione/danno, turno passivo, ripresa e riavvio; nessuna scrittura PvP o notifica | `yugioh-auto-practice-browser-smoke.mjs` |

Le decisioni passive usano anche fixture sintetiche delle famiglie del protocollo; sono distinte dalle partite con carte reali. Il browser personale impiega identità e storage in memoria, non account o righe di produzione. Gli screenshot sono in `artifacts/yugioh-auto-practice/`.

La copertura reale dimostra le principali famiglie di meccaniche del duello TCG e i relativi collegamenti con il servizio FPT. Restano non certificati individualmente i circa 15.000 passcode del catalogo, tutte le interazioni fra carte, le eccezioni di ogni archetipo e tutte le varianti storiche del protocollo. Effetti e vincoli di quelle carte sono affidati al motore e agli script inclusi; una singola combinazione non provata resta **non verificata**, non automaticamente assente o garantita.

La modalità qui verificata è il duello singolo privato fra due membri con regole TCG moderne, con lo stesso core disponibile in Testa mazzo personale contro un campo passivo. Match con sideboarding, Tag/Rush/GOAT, avversario AI strategico e parità grafica completa con Master Duel non sono funzionalità attestate da questa matrice.

L’audit ha corretto ordinamento privato delle carte, semantica degli opcode e delle somme, cima pubblica dei mazzi rovesciati, relazioni Equip/bersagli/proprietario, materiali di Xyz coperti e chiusura delle vittorie iniziali. Il profilo risorse `-tcg-r2` ripara lo script mancante di Red-Eyes Darkness Metal Dragon e conserva intatti gli archivi precedenti per i replay delle partite aperte. La ricostruzione di archivi, manifest e avvisi è stata confrontata byte per byte.

Le fixture browser aggiunte per gallerie dei materiali, cima del mazzo e dettagli Equip sono esplicitamente **solo presentazione**: verificano tocchi e descrizioni a 844×390 e 740×360, senza modificare partita nativa o righe del servizio. Le relative meccaniche sono provate separatamente attraverso i veri effetti del core. La partita mobile principale continua a usare servizio e worker reali, due contesti separati e 41 risposte del motore.

Comandi mirati per ripetere questo audit:

```sh
node scripts/yugioh-auto-mechanics-smoke.mjs
node scripts/yugioh-auto-protocol-live-smoke.mjs
node scripts/yugioh-auto-state-events-smoke.mjs
node scripts/yugioh-auto-catalog-smoke.mjs
npm run test:yugioh-auto
npm run test:yugioh-simulator
```
