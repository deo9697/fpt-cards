const port = Number(process.argv[2] || 9351);
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(target => target.type === 'page' && target.url.includes('localhost:8080'));
if (!tab) throw new Error('Scheda F.P.T Cards non trovata');

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once:true });
  socket.addEventListener('error', reject, { once:true });
});

const repairs = [
  { loanId:'16c102d9-84eb-41b8-a3e1-a11801cd155c', cardId:'73542331' },
  { loanId:'785aa444-07e0-4ca7-bf9c-c5ed768bca4f', cardId:'94145021' }
];
const expression = `(async()=>{
  const {api}=await import('./js/api.js');
  const repairs=${JSON.stringify(repairs)};
  for(const repair of repairs){
    const image='https://images.ygoprodeck.com/images/cards/'+repair.cardId+'.jpg';
    await api.enrichLoan(repair.loanId,{id:repair.cardId,image,fullImage:image});
  }
  return repairs.length;
})()`;

socket.send(JSON.stringify({ id:1, method:'Runtime.evaluate', params:{ expression, awaitPromise:true, returnByValue:true } }));
const repaired = await new Promise((resolve, reject) => {
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    if (message.error || message.result?.exceptionDetails) {
      const details = message.result?.exceptionDetails;
      reject(new Error(details?.exception?.description || details?.text || message.error?.message));
    } else resolve(message.result.result.value);
  });
});
socket.close();
console.log(`repair-known-card-images: ${repaired} record inviati`);
