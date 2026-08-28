import { resolveStoredCard } from '../js/cards.js';

const cases = [
  {
    stored:{ id:'97973387', name:'Droll & Lock Bird', setCode:'OP08-EN001' },
    expectedId:'94145021'
  },
  {
    stored:{ id:'97973387', name:'Droll', setCode:'OP08-EN001' },
    expectedId:'94145021'
  },
  {
    stored:{ id:'94145021', name:'Kashtira Shangri-Ira', setCode:'DABL-EN045' },
    expectedId:'73542331'
  }
];

for (const test of cases) {
  const card = await resolveStoredCard(test.stored, 'yugioh');
  if (String(card?.id) !== test.expectedId) {
    throw new Error(`Risoluzione errata per ${test.stored.name}: ${card?.id || 'nessun risultato'}`);
  }
  if (!card.fullImage.endsWith(`/${test.expectedId}.jpg`)) {
    throw new Error(`URL immagine errato per ${test.stored.name}: ${card.fullImage}`);
  }
}

console.log('card-image-resolution-smoke: ok');
