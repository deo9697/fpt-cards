# Product priorities

- FPT Cards is a smartphone-first PWA. Design and verify phone interactions before desktop layouts.
- Duel arenas on phones require landscape: request the real orientation lock when supported and provide a blocking rotate prompt when the browser cannot rotate automatically. Release orientation/fullscreen changes when leaving the arena.
- Card artwork must keep its proportions and fill equivalent play zones consistently, including Extra Monster Zones. Verify both Attack and Defense positions on phone-sized viewports.
- In the manual Yu-Gi-Oh! arena, a tap opens a small list beside the card with at most three primary actions (Normal Summon, Special Summon, Set for monsters; Activate and Set for Spells/Traps). Holding a stationary card opens its description; moving after the initial hold still supports dragging to a destination. Card descriptions and advanced commands remain optional for playing.
