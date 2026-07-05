D&D TableTop v16 - Stable Local Sync

Avvio:
npm install
npm start

Novita v16:
- Fix blocchi dopo disegno intenso: i tratti ora viaggiano come delta leggeri invece che come stato completo.
- Fix storico Undo/Redo: non salva piu' copie complete di tutti i disegni a ogni gesto.
- Fix ricarica mappa: i client non ridecodificano la mappa a ogni update parziale.
- Disegni renderizzati con cache su canvas separato per ridurre CPU su tablet.
- WebSocket diretto in LAN/hotspot, senza fallback polling.
- Nebbia e movimenti pedine sincronizzati in batch/throttle.
- Limiti di sicurezza lato client/server su punti, disegni e stroke nebbia.

Uso consigliato in locale:
1. Avvia il server sul PC Master con `npm start`.
2. Apri dal PC Master `http://localhost:3000`.
3. Da tablet/player apri `http://IP_DEL_PC:3000` sulla stessa rete/hotspot.
