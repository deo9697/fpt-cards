// Accademia del Duellante: contenuti del tutorial Yu-Gi-Oh! per neofiti.
// Solo dati: capitoli (pagine + quiz) e il duello guidato già scritto.
// I testi seguono le regole ufficiali TCG e i testi carta di YGOPRODeck
// (controllati il 2026-11-09). Il duello è un percorso fisso con scelte
// a risposta: non è una partita libera.

const card = id => `https://images.ygoprodeck.com/images/cards/${id}.jpg`;
export const CARDS = {
  ash: { id: '14558127', name: 'Ash Blossom & Joyous Spring', image: card('14558127') },
  terraforming: { id: '73628505', name: 'Terraforming', image: card('73628505') },
  raye: { id: '26077387', name: 'Sky Striker Ace - Raye', image: card('26077387') },
  kagari: { id: '63288573', name: 'Sky Striker Ace - Kagari', image: card('63288573') },
  engage: { id: '63166095', name: 'Sky Striker Mobilize - Engage!', image: card('63166095') },
  jamming: { id: '25955749', name: 'Sky Striker Maneuver - Jamming Waves!', image: card('25955749') },
  widow: { id: '98338152', name: 'Sky Striker Mecha - Widow Anchor', image: card('98338152') },
  hornet: { id: '52340444', name: 'Sky Striker Mecha - Hornet Drones', image: card('52340444') },
  veiler: { id: '97268402', name: 'Effect Veiler', image: card('97268402') },
  stratos: { id: '40044918', name: 'Elemental HERO Stratos', image: card('40044918') },
  impermanence: { id: '10045474', name: 'Infinite Impermanence', image: card('10045474') }
};

// Lady Sim compare solo sul profilo di Simona Costanzo, quando sbagli.
export const LADY_SIM_LINES = ['Gnaus!', 'Te chiude u culu a tia ah!'];

export const FIELD_ZONES = {
  monster: ['Zona Mostro', 'Qui evochi i tuoi <b>mostri</b>: in Attacco (verticali) o in Difesa (orizzontali). Ne hai <b>5</b>.'],
  st: ['Zona Magia/Trappola', 'Qui attivi le <b>Magie</b> o <em>posizioni coperte</em> le Trappole, che puoi attivare dal turno successivo. Ne hai 5.'],
  pendulum: ['Zona Magia/Trappola · Scala Pendulum', 'Le due zone agli estremi valgono anche come <b>Zone Pendulum</b>: lì metti le Scale per evocare per Pendulum.'],
  field: ['Zona Terreno', 'Qui va <b>una sola</b> Magia Terreno alla volta. Se ne attivi un\'altra, la vecchia va al Cimitero.'],
  gy: ['Cimitero', 'Le carte distrutte, usate o scartate finiscono qui, <b>scoperte</b>. Molte carte lavorano proprio dal Cimitero!'],
  deck: ['Deck', 'Il tuo Main Deck coperto, da <b>40 a 60 carte</b>. A inizio duello peschi 5 carte.'],
  extra: ['Extra Deck', 'Fino a <b>15 carte</b> tra Fusione, Synchro, Xyz e Link. Non si pescano: le evochi quando hai i materiali giusti.'],
  emz: ['Zona Mostro Extra', 'Le due zone al centro sono <b>condivise</b>: i mostri evocati dall\'Extra Deck vanno qui, oppure in una Zona Mostro a cui punta una freccia Link. Di norma ne usi <b>una</b>.']
};

const q = (text, options, answer, why) => ({ text, options, answer, why });

export const CHAPTERS = [
  {
    id: 'basi', title: 'Le basi', blurb: '8000 LP, il mazzo e i tre tipi di carta',
    pages: [
      { mood: 'welcome', text: 'Benvenuto, recluta! Ogni duellante parte con <b>8000 Life Point</b>. Vinci quando porti quelli dell\'avversario a <b>0</b>, oppure se lui deve pescare e il suo Deck è vuoto.' },
      { mood: 'who', text: 'Il tuo mazzo ha tre parti. Il <b>Main Deck</b> da <b>40 a 60</b> carte, quello da cui peschi. L\'<b>Extra Deck</b> fino a <b>15</b> carte, con i mostri speciali. Il <b>Side Deck</b> fino a <b>15</b> carte, per cambiare il mazzo tra un duello e l\'altro di un match.' },
      { mood: 'who', text: 'Della stessa carta puoi mettere al massimo <b>3 copie</b> in tutto, Main, Extra e Side insieme. Alcune carte sono <em>Limitate</em> (1 copia), <em>Semi-Limitate</em> (2) o <em>Proibite</em>: lo decide la lista ufficiale.' },
      { mood: 'who', text: 'Le carte sono di tre tipi. I <b>Mostri</b> combattono. Le <b>Magie</b> (verdi) le usi soprattutto nel tuo turno. Le <b>Trappole</b> (viola) le posizioni coperte e le attivi anche nel turno avversario.' },
      { mood: 'welcome', text: 'A inizio duello ognuno pesca <b>5 carte</b>. Chi gioca per primo <em>non pesca</em> al primo turno e <em>non può attaccare</em>: è il prezzo del vantaggio di partire.' }
    ],
    quiz: [
      q('Con quanti Life Point inizi un duello?', ['4000', '8000', '10000'], 1, 'Si parte sempre da 8000 LP.'),
      q('Quante copie della stessa carta puoi avere al massimo nel mazzo (se non è limitata)?', ['2', '3', '4'], 1, 'Massimo 3 copie in tutto, contando Main, Extra e Side.'),
      q('Chi gioca per primo può attaccare al suo primo turno?', ['Sì, se ha un mostro', 'No, mai', 'Solo con le Trappole'], 1, 'Al primo turno del duello non si può attaccare, e chi inizia non pesca.')
    ]
  },
  {
    id: 'terreno', title: 'Il terreno', blurb: 'Le zone e a cosa servono', field: true,
    pages: [
      { mood: 'who', text: 'Questo è il tuo lato del terreno. <b>Tocca una zona</b> e ti spiego a cosa serve. Quando le hai viste, vai avanti.' }
    ],
    quiz: [
      q('Dove va un mostro Link evocato dall\'Extra Deck?', ['In qualunque Zona Magia/Trappola', 'In una Zona Mostro Extra, o in una Zona Mostro indicata da un Link', 'Nel Cimitero'], 1, 'I mostri dall\'Extra Deck vanno nella Zona Mostro Extra o dove punta una freccia Link.'),
      q('Quante Magie Terreno puoi avere attive alla volta?', ['Una', 'Due', 'Cinque'], 0, 'C\'è una sola Zona Terreno per giocatore.'),
      q('Dove finisce un mostro distrutto in battaglia?', ['Torna nel Deck', 'Nel Cimitero', 'In mano'], 1, 'Le carte distrutte vanno nel Cimitero, scoperte.')
    ]
  },
  {
    id: 'turno', title: 'Il turno', blurb: 'Le sei fasi, con esempi',
    pages: [
      { mood: 'who', text: 'Ogni turno ha sei fasi, sempre in quest\'ordine. <b>1. Draw Phase</b>: peschi 1 carta. <b>2. Standby Phase</b>: si risolvono gli effetti che dicono "durante la Standby Phase".' },
      { mood: 'who', text: '<b>3. Main Phase 1</b>: evochi mostri, attivi Magie, posizioni carte. Qui fai quasi tutto. Puoi fare <b>una sola Evocazione Normale</b> (o Posizionare coperto un mostro) per turno; le Evocazioni Speciali invece non hanno limite, salvo quanto dicono le carte.' },
      { mood: 'who', text: '<b>4. Battle Phase</b>: i tuoi mostri in Attacco possono attaccare, una volta ciascuno. <b>5. Main Phase 2</b>: come la prima, per sistemarti dopo la battaglia. <b>6. End Phase</b>: chiudi il turno; se hai più di 6 carte in mano, scarti fino a 6.' },
      { mood: 'welcome', text: 'Esempio: peschi, evochi un mostro in Main Phase 1, attacchi in Battle Phase, poi in Main Phase 2 posizioni una Trappola coperta per il turno avversario. Fine turno!' }
    ],
    quiz: [
      q('In quale fase peschi la carta del turno?', ['Draw Phase', 'Main Phase 1', 'End Phase'], 0, 'Si pesca all\'inizio, nella Draw Phase.'),
      q('Quante Evocazioni Normali puoi fare per turno?', ['Una', 'Due', 'Quante vuoi'], 0, 'Una sola Evocazione Normale (o Posizionamento) per turno.'),
      q('Hai 8 carte in mano alla End Phase. Cosa succede?', ['Niente', 'Scarti fino ad averne 6', 'Le rimetti nel Deck'], 1, 'Alla fine del turno il limite della mano è 6 carte.')
    ]
  },
  {
    id: 'evocazioni', title: 'Le evocazioni', blurb: 'Normale, Tributo e le Evocazioni dall\'Extra Deck',
    pages: [
      { mood: 'who', text: '<b>Evocazione Normale</b>: i mostri di Livello da 1 a 4 si evocano senza costi. Livello 5 o 6: devi <em>offrire 1 mostro</em> come Tributo. Livello 7 o più: <em>2 Tributi</em>.' },
      { mood: 'who', text: '<b>Fusione</b>: di solito usi una Magia come "Polymerization" e mandi al Cimitero i materiali scritti sul mostro Fusione. <b>Rituale</b>: usi una Magia Rituale e offri mostri la cui somma dei Livelli arriva a quello richiesto.' },
      { mood: 'who', text: '<b>Synchro</b>: un mostro <em>Tuner</em> più altri mostri non-Tuner, e la somma dei Livelli deve essere uguale al Livello del Synchro. Esempio: Tuner Livello 3 + mostro Livello 4 = Synchro Livello 7.' },
      { mood: 'who', text: '<b>Xyz</b>: due o più mostri con <em>lo stesso Livello</em> diventano materiali sotto il mostro Xyz, che ha un <b>Rango</b>, non un Livello. Due Livello 4 = un Xyz di Rango 4. I materiali si "staccano" per attivare i suoi effetti.' },
      { mood: 'who', text: '<b>Link</b>: mandi al Cimitero tanti mostri quanto il suo <em>valore Link</em> (un mostro Link può contare come più materiali). Le sue <b>frecce</b> indicano le zone dove puoi evocare altri mostri dall\'Extra Deck.' },
      { mood: 'welcome', text: '<b>Pendulum</b>: metti due mostri Pendulum nelle Zone Scala agli estremi. Una volta per turno puoi evocare insieme mostri con Livello <em>compreso tra le due Scale</em>. Esempio: Scale 1 e 8 → Livelli da 2 a 7.' }
    ],
    quiz: [
      q('Vuoi evocare normalmente un mostro di Livello 7. Quanti Tributi servono?', ['Nessuno', '1', '2'], 2, 'Livello 7 o più richiede 2 Tributi.'),
      q('Tuner di Livello 3 + mostro non-Tuner di Livello 4: che Synchro puoi evocare?', ['Livello 4', 'Livello 7', 'Rango 7'], 1, 'Per il Synchro si sommano i Livelli: 3 + 4 = 7.'),
      q('Con due mostri di Livello 4 evochi un Xyz di…', ['Rango 4', 'Livello 8', 'Rango 8'], 0, 'Gli Xyz hanno un Rango pari al Livello comune dei materiali.')
    ]
  },
  {
    id: 'battaglia', title: 'La battaglia', blurb: 'ATK, DEF e il calcolo dei danni',
    pages: [
      { mood: 'who', text: 'Un mostro in <b>Attacco</b> (verticale) usa i suoi ATK. In <b>Difesa</b> (orizzontale) usa i DEF e non può attaccare. Puoi cambiare posizione una volta per turno, ma non nel turno in cui l\'hai evocato.' },
      { mood: 'who', text: '<b>Attacco contro Attacco</b>: il più debole viene distrutto e il suo controllore perde la differenza. Esempio: 2500 contro 2000 → il mostro da 2000 è distrutto e l\'avversario perde 500 LP. Se sono uguali, si distruggono tutti e due senza danni.' },
      { mood: 'who', text: '<b>Attacco contro Difesa</b>: se l\'ATK supera la DEF, il mostro in Difesa è distrutto ma <em>nessuno perde LP</em>. Se l\'ATK è più basso, non si distrugge niente e <em>chi attacca</em> perde la differenza.' },
      { mood: 'welcome', text: 'Se l\'avversario non ha mostri, puoi fare un <b>attacco diretto</b>: lui perde tanti LP quanti gli ATK del tuo mostro.' }
    ],
    quiz: [
      q('Il tuo mostro da 2500 ATK attacca un mostro da 2000 ATK in Attacco. Risultato?', ['L\'avversario perde 500 LP e il suo mostro', 'Non succede nulla', 'Perdi tu 500 LP'], 0, 'Attacco contro Attacco: il più debole è distrutto e il suo controllore perde la differenza.'),
      q('Attacchi con 1800 ATK un mostro in Difesa con 2000 DEF. Cosa succede?', ['Il mostro in Difesa è distrutto', 'Perdi 200 LP e nessuno è distrutto', 'L\'avversario perde 200 LP'], 1, 'ATK più basso della DEF: chi attacca perde la differenza, niente distrutto.'),
      q('Attacchi con 1500 ATK un mostro in Difesa con 1000 DEF. Quanti LP perde l\'avversario?', ['500', '1500', '0'], 2, 'Contro un mostro in Difesa non si fanno danni, salvo effetti speciali.')
    ]
  },
  {
    id: 'catene', title: 'Catene ed effetti', blurb: 'Perché si risolvono al contrario',
    pages: [
      { mood: 'who', text: 'Quando attivi una carta, l\'avversario può <b>rispondere</b> con un\'altra: si forma una <b>Catena</b>. Ogni risposta è un nuovo anello: Catena 1, Catena 2, Catena 3…' },
      { mood: 'who', text: 'La Catena si risolve <b>al contrario</b>: prima l\'ultimo anello, poi il precedente, fino al primo. Così chi risponde per ultimo agisce per primo.' },
      { mood: 'who', text: 'Non tutto può rispondere. Le <b>Magie Normali</b> non possono: si attivano solo come Catena 1. Possono rispondere le <b>Magie Rapide</b>, le <b>Trappole</b> e gli effetti dei mostri con <em>(Quick Effect)</em>.' },
      { mood: 'panic', text: 'Le <b>hand trap</b> sono mostri che usi <em>dalla mano</em> nel turno avversario. Esempio: <b>Ash Blossom</b> si scarta per annullare un effetto che aggiunge una carta dal Deck alla mano. Le incontrerai in ogni duello!' }
    ],
    quiz: [
      q('Catena 1: Magia dell\'avversario. Catena 2: la tua risposta. Cosa si risolve prima?', ['La Magia dell\'avversario', 'La tua risposta', 'Si annullano entrambe'], 1, 'Le Catene si risolvono dall\'ultimo anello al primo.'),
      q('Puoi rispondere a una Magia con una Magia Normale?', ['Sì, sempre', 'No, le Magie Normali non rispondono', 'Solo nel tuo turno'], 1, 'Le Magie Normali si attivano solo come Catena 1.'),
      q('Cosa annulla Ash Blossom?', ['Un attacco', 'Un effetto che aggiunge una carta dal Deck alla mano', 'Qualunque Trappola'], 1, 'Ash annulla gli effetti che aggiungono dal Deck alla mano, evocano dal Deck o mandano dal Deck al Cimitero.')
    ]
  },
  {
    id: 'mazzo', title: 'Il primo mazzo', blurb: 'Formato Advanced e come costruirlo',
    pages: [
      { mood: 'who', text: 'Nel formato <b>Advanced</b> si gioca con la lista ufficiale delle carte Proibite, Limitate e Semi-Limitate. È il formato dei tornei e quello che usiamo nel deck builder.' },
      { mood: 'who', text: 'Resta vicino alle <b>40 carte</b>: meno carte vuol dire pescare più spesso quelle importanti. Per partire va benissimo uno <b>Structure Deck</b> o un archetipo con regole semplici.' },
      { mood: 'who', text: 'Un mazzo ha carte che <em>avviano</em> la giocata (starter), carte che la <em>allungano</em> (extender) e <em>hand trap</em> per il turno avversario. In <b>Mazzi → ⋯ → Statistiche mano</b> l\'app simula 200.000 mani e ti dice quanto spesso apri bene.' },
      { mood: 'welcome', text: 'Costruiscilo davvero: cerca le carte nella <b>Raccolta</b>, crea il mazzo nel <b>deck builder</b> e chiedi in prestito al team quello che ti manca.' }
    ],
    quiz: [
      q('Cosa decide quante copie puoi usare di una carta nel formato Advanced?', ['La lista ufficiale Proibite/Limitate', 'Il colore della carta', 'Il tuo livello'], 0, 'La lista ufficiale stabilisce Proibite, Limitate (1) e Semi-Limitate (2).'),
      q('Perché conviene stare vicino a 40 carte?', ['Perché è obbligatorio', 'Peschi più spesso le carte importanti', 'Per avere più Life Point'], 1, 'Meno carte nel mazzo vuol dire più costanza.'),
      q('Una carta Limitata: quante copie puoi metterne?', ['1', '2', '3'], 0, 'Limitata = 1 copia.')
    ]
  },
  {
    id: 'leggere', title: 'Come leggere una carta', blurb: 'Livello, Rango, Link e il testo degli effetti',
    pages: [
      { mood: 'who', text: 'In alto ci sono il nome e l\'<b>Attributo</b> (LIGHT, DARK, FIRE…). Sotto, le stelle: rosse per il <b>Livello</b>, nere per il <b>Rango</b> degli Xyz. I mostri Link non hanno stelle ma <b>frecce</b> e un valore <em>LINK-N</em>.' },
      { mood: 'who', text: 'Il testo ha una grammatica precisa. Prima dei <b>due punti</b> ci sono le condizioni. Tra i due punti e il <b>punto e virgola</b> c\'è il <em>costo</em>, che paghi anche se poi l\'effetto viene annullato. Dopo il punto e virgola c\'è l\'effetto.' },
      { mood: 'who', text: 'Esempio da Ash Blossom: "You can discard this card; negate that effect". Il costo è <b>scartare la carta</b>, l\'effetto è <b>annullare</b>. "(Quick Effect)" vuol dire che puoi usarlo anche nel turno avversario, in risposta.' },
      { mood: 'welcome', text: '"You can only use this effect … once per turn" vale per <b>tutte le copie</b> di quella carta: anche con tre copie, quell\'effetto lo usi una volta sola per turno.' }
    ],
    quiz: [
      q('Nel testo "You can discard this card; negate that effect", qual è il costo?', ['Annullare l\'effetto', 'Scartare la carta', 'Non c\'è costo'], 1, 'Quello che sta prima del punto e virgola è il costo.'),
      q('Un mostro Xyz ha…', ['Un Livello', 'Un Rango', 'Un valore Link'], 1, 'Gli Xyz hanno il Rango, con le stelle nere.'),
      q('Cosa significa "(Quick Effect)"?', ['Che si attiva solo nel tuo turno', 'Che puoi usarlo anche in risposta, nel turno avversario', 'Che costa meno'], 1, 'Gli effetti rapidi possono rispondere e funzionano anche nel turno dell\'avversario.')
    ]
  }
];

// Il duello guidato si sblocca dopo "Catene ed effetti".
export const DUEL_UNLOCK_AFTER = 'catene';

// Stato del tavolo a ogni passo: lp, mani e zone (id di CARDS, 'back' = carta
// coperta). choice: risposte con una sola giusta; dopo quella giusta il
// duello prosegue.
const board = (o = {}) => ({ lpYou: 8000, lpOpp: 8000, phase: '', oppMonsters: [], oppSpells: [], youEmz: '', youMonsters: [], youSpells: [], hand: [], active: '', ...o });
const START_HAND = ['ash', 'raye', 'engage', 'veiler', 'widow'];

export const DUEL = {
  title: 'Sky Striker contro HERO',
  intro: 'Tu giochi <b>Sky Striker</b>, l\'avversario <b>Elemental HERO</b>. Lui va per primo. Hai pescato 5 carte: guarda la tua mano qui sotto.',
  steps: [
    { mood: 'welcome', title: 'Si comincia', board: board({ phase: 'Turno 1 · avversario', hand: START_HAND }), text: 'Tu giochi <b>Sky Striker</b>, l\'avversario <b>Elemental HERO</b>. Lui va per primo. In mano hai Ash Blossom, Raye, Engage, Effect Veiler e Widow Anchor.' },
    { mood: 'panic', title: 'La prima hand trap', board: board({ phase: 'Turno 1 · Main Phase 1', hand: START_HAND, oppSpells: ['terraforming'], active: 'terraforming' }),
      text: 'L\'avversario attiva <b>Terraforming</b>: vuole aggiungere una Magia Terreno <em>dal Deck alla mano</em>. Hai <b>Ash Blossom</b>. Cosa fai?',
      choice: { options: [
        ['Scarto Ash Blossom e la attivo in Catena a Terraforming', true, 'Esatto! Ash si attiva <b>in risposta</b>, come Catena 2: si risolve prima e <em>annulla l\'effetto</em> di Terraforming. Niente Magia Terreno per lui.'],
        ['Lascio risolvere: tengo Ash per dopo', false, 'Così prende la sua carta. Contro una ricerca dal Deck è <b>il momento perfetto</b> per Ash. Riprova!'],
        ['Aspetto che risolva, poi attivo Ash', false, 'Troppo tardi: una volta risolta, la carta è già in mano sua. Ash va attivata <b>in Catena</b>, prima che l\'effetto si risolva.']
      ] } },
    { mood: 'who', title: 'Fine del suo turno', board: board({ phase: 'Turno 1 · End Phase', hand: ['raye', 'engage', 'veiler', 'widow'], oppSpells: ['back'] }), text: 'Terraforming va al Cimitero senza effetto, Ash al tuo Cimitero. L\'avversario <b>posiziona una carta coperta</b> e chiude il turno.' },
    { mood: 'who', title: 'Tocca a te', board: board({ phase: 'Turno 2 · Draw Phase', hand: ['raye', 'engage', 'veiler', 'widow', 'hornet'], oppSpells: ['back'] }), text: 'Tu giochi per secondo, quindi <b>peschi</b>: Hornet Drones. Le Magie Sky Striker hanno una condizione: "If you control <em>no monsters in your Main Monster Zone</em>". Tienilo a mente.' },
    { mood: 'who', title: 'Prima mossa', board: board({ phase: 'Turno 2 · Main Phase 1', hand: ['raye', 'engage', 'veiler', 'widow', 'hornet'], oppSpells: ['back'] }),
      text: 'Hai Raye da evocare ed Engage da attivare. <b>Cosa fai per prima?</b>',
      choice: { options: [
        ['Evoco normalmente Raye', false, 'Raye finirebbe in una Zona Mostro principale e le Magie Sky Striker non si potrebbero più attivare: vogliono la <b>Main Monster Zone vuota</b>. Riprova!'],
        ['Attivo Engage', true, 'Giusto! Con la Main Monster Zone vuota, <b>Engage</b> aggiunge una carta "Sky Striker" dal Deck alla mano. Le Magie prima, il mostro dopo.'],
        ['Vado in Battle Phase', false, 'Non hai ancora mostri con cui attaccare. Prima prepara il terreno!']
      ] } },
    { mood: 'welcome', title: 'Engage e Jamming Waves', board: board({ phase: 'Turno 2 · Main Phase 1', hand: ['raye', 'veiler', 'widow', 'hornet'], oppSpells: ['back'], youSpells: ['jamming'], active: 'jamming' }),
      text: 'Engage aggiunge <b>Jamming Waves</b>. Poi la attivi sulla carta coperta dell\'avversario: è distrutta. Era <b>Infinite Impermanence</b>, ma non poteva usarla: non avevi mostri scoperti da bersagliare. Hai 2 Magie nel Cimitero.' },
    { mood: 'who', title: 'Raye e Kagari', board: board({ phase: 'Turno 2 · Main Phase 1', hand: ['engage', 'veiler', 'widow', 'hornet'], youEmz: 'kagari', active: 'kagari' }),
      text: 'Evochi normalmente <b>Raye</b>, poi usi il suo effetto: lo offri come Tributo ed evochi <b>Kagari</b> dall\'Extra Deck nella <b>Zona Mostro Extra</b>. Kagari riprende Engage dal Cimitero e guadagna 100 ATK per ogni Magia nel Cimitero: ora 1600.' },
    { mood: 'who', title: 'Di nuovo Engage?', board: board({ phase: 'Turno 2 · Main Phase 1', hand: ['engage', 'veiler', 'widow', 'hornet'], youEmz: 'kagari' }),
      text: 'Raye è nel Cimitero e Kagari sta nella Zona Mostro Extra. <b>Puoi attivare di nuovo Engage?</b>',
      choice: { options: [
        ['Sì: la Zona Mostro Extra non è una Main Monster Zone', true, 'Esatto! Le tue Zone Mostro principali sono vuote, quindi le Magie Sky Striker funzionano ancora. È il trucco di tutto il mazzo.'],
        ['No: ho già un mostro sul terreno', false, 'La condizione parla solo della <b>Main Monster Zone</b>. Kagari è nella Zona Mostro Extra, che non conta. Riprova!']
      ] } },
    { mood: 'welcome', title: 'Battle Phase', board: board({ phase: 'Turno 2 · Battle Phase', hand: ['veiler', 'widow', 'hornet', 'jamming'], youEmz: 'kagari' }),
      text: 'Engage aggiunge un\'altra Jamming Waves. Kagari ora ha <b>1700 ATK</b>. L\'avversario non ha mostri. <b>Cosa fai?</b>',
      choice: { options: [
        ['Attacco direttamente con Kagari', true, 'Perfetto: nessun mostro a difenderlo, quindi <b>attacco diretto</b>. L\'avversario scende a 6300 LP.'],
        ['Non attacco: Kagari è stato evocato questo turno', false, 'Un mostro evocato in questo turno <b>può attaccare</b>. È solo al primo turno del duello che non si attacca. Riprova!'],
        ['Attacco con Raye', false, 'Raye è nel Cimitero: l\'hai offerto per evocare Kagari. Riprova!']
      ] } },
    { mood: 'panic', title: 'Il turno avversario', board: board({ lpOpp: 6300, phase: 'Turno 3 · Main Phase 1', hand: ['veiler', 'widow', 'hornet', 'jamming'], youEmz: 'kagari', oppMonsters: ['stratos'], active: 'stratos' }),
      text: 'L\'avversario evoca <b>Elemental HERO Stratos</b> e ne attiva l\'effetto: aggiungere un mostro "HERO" <em>dal Deck alla mano</em>. Ash l\'hai già usata. <b>Cosa fai?</b>',
      choice: { options: [
        ['Attivo Effect Veiler dalla mano su Stratos', true, 'Sì! Veiler si usa <b>nella Main Phase dell\'avversario</b> e annulla gli effetti di Stratos: l\'effetto che ha appena attivato non fa nulla.'],
        ['Attivo Widow Anchor', false, 'Widow Anchor è una <b>Magia Normale</b>: si attiva solo nel tuo turno. Riprova!'],
        ['Aspetto la sua Battle Phase per usare Veiler', false, 'Veiler funziona solo <b>durante la Main Phase avversaria</b>. In Battle Phase è troppo tardi. Riprova!']
      ] } },
    { mood: 'panic', title: 'Kagari cade', board: board({ lpOpp: 6300, lpYou: 7900, phase: 'Turno 3 · Battle Phase', hand: ['widow', 'hornet', 'jamming'], oppMonsters: ['stratos'] }),
      text: 'Stratos (1800 ATK) attacca Kagari (1700): Kagari è distrutto e perdi <b>100 LP</b>. Raye è nel tuo Cimitero. <b>Cosa può fare?</b>',
      choice: { options: [
        ['Si evoca dal Cimitero: un mostro Link "Sky Striker Ace" è stato distrutto in battaglia', true, 'Esatto! Il secondo effetto di Raye lo riporta in campo quando il tuo Link Sky Striker cade. È un effetto diverso dal primo, quindi puoi usarlo.'],
        ['Niente: Raye ha già usato il suo effetto', false, 'Il limite "once per turn" vale <b>per ogni effetto</b>, e questo è un altro turno. Riprova!']
      ] } },
    { mood: 'welcome', title: 'Fine del duello guidato', board: board({ lpOpp: 6300, lpYou: 7900, phase: 'Turno 3 · fine', hand: ['widow', 'hornet', 'jamming'], oppMonsters: ['stratos'], youMonsters: ['raye'] }),
      text: 'Raye torna in campo e il duello continua… ma la lezione è finita! Hai usato due <b>hand trap</b>, la regola della <b>Main Monster Zone</b>, la <b>Zona Mostro Extra</b> e la battaglia. Ora sei pronto per un duello vero.' }
  ]
};
