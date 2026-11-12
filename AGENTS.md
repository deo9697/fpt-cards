# Product priorities

- FPT Cards is a smartphone-first PWA. Design and verify phone interactions before desktop layouts.
- Duel arenas on phones require landscape: request the real orientation lock when supported and provide a blocking rotate prompt when the browser cannot rotate automatically. Release orientation/fullscreen changes when leaving the arena.
- Card artwork must keep its proportions and fill equivalent play zones consistently, including Extra Monster Zones. Verify both Attack and Defense positions on phone-sized viewports.
- In the manual Yu-Gi-Oh! arena, make primary card plays available by holding and dragging a card to its destination, then choosing a compact contextual action. A large card-details view must remain optional for playing cards.
