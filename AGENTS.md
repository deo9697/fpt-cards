# Product priorities

- FPT Cards is a smartphone-first PWA. Design and verify phone interactions before desktop layouts.
- Duel arenas on phones require landscape: request the real orientation lock when supported and provide a blocking rotate prompt when the browser cannot rotate automatically. Release orientation/fullscreen changes when leaving the arena.
- Card artwork must keep its proportions and fill equivalent play zones consistently, including Extra Monster Zones. Verify both Attack and Defense positions on phone-sized viewports.
- In the manual Yu-Gi-Oh! arena, a tap opens a small list beside the card with compact primary actions (Normal Summon, Special Summon, Set for monsters, plus Activate for effects in hand; Activate and Set for Spells/Traps). Holding a stationary card opens its description; moving after the initial hold still supports dragging to a destination. Card descriptions and advanced commands remain optional for playing.
- Activation feedback shows the public activated card in the center, with its chain number over the artwork; retain card thumbnails for unresolved links and keep response controls usable.
- Special Summon asks for face-up Attack or Defense in a compact position chooser before committing the play; preserve the choice through tap, drag and Extra Deck materials. Link Monsters offer Attack only.
- New Yu-Gi-Oh! tables guide turn order, normal draws, shared Normal Summon/Set allowance, standard tributes, battle-position changes and end-turn discards. Keep effect exceptions explicit and optional; old tables retain their manual controls.
