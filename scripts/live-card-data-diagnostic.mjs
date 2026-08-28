const port = Number(process.argv[2] || 9351);
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(target => target.type === 'page' && target.url.includes('localhost:8080'));
if (!tab) throw new Error('Scheda F.P.T Cards non trovata');

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once:true });
  socket.addEventListener('error', reject, { once:true });
});

const expression = `(()=>{
  const saved=JSON.parse(localStorage.getItem('fpt-cards-state-v2')||'null');
  const relevant=value=>/droll|shangri/i.test(String(value||''));
  return {
    page:document.body.dataset.page,
    user:saved?.currentUser||null,
    hash:location.hash,
    loans:(saved?.loans||[]).filter(item=>relevant(item.cardName)).map(item=>({
      id:item.id,cardName:item.cardName,externalId:item.externalId,image:item.image,
      collectionItemId:item.collectionItemId,game:item.game,status:item.status
    })),
    loanIndex:(saved?.loans||[]).map(item=>({id:item.id,cardName:item.cardName,externalId:item.externalId,image:item.image,game:item.game,status:item.status})),
    mine:(saved?.collection?.mine||[]).filter(item=>relevant(item.cardName)).map(item=>({
      id:item.id,cardName:item.cardName,catalogCardId:item.catalogCardId,imageUrl:item.imageUrl,
      setCode:item.setCode,printingId:item.printingId,imageMismatch:item.imageMismatch
    })),
    team:(saved?.collection?.team||[]).filter(item=>relevant(item.cardName)).map(item=>({
      id:item.id,ownerSlug:item.ownerSlug,cardName:item.cardName,catalogCardId:item.catalogCardId,imageUrl:item.imageUrl,
      setCode:item.setCode,printingId:item.printingId,imageMismatch:item.imageMismatch
    })),
    rendered:[...document.images].filter(image=>relevant(image.alt)||relevant(image.closest('button,article')?.textContent)).map(image=>({
      alt:image.alt,src:image.currentSrc||image.src,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,
      failed:image.dataset.cardImageFailed||''
    }))
  };
})()`;

socket.send(JSON.stringify({ id:1, method:'Runtime.evaluate', params:{ expression, returnByValue:true } }));
const result = await new Promise((resolve, reject) => {
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message || message.result.exceptionDetails.text));
    else resolve(message.result.result.value);
  });
});
socket.close();
console.log(JSON.stringify(result, null, 2));
