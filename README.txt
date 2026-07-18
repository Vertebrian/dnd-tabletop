D&D TableTop v17 - Render Sync Debugged
=======================================

File da mantenere
-----------------
Questi file sostituiscono index.html, server.js e package.json della versione precedente.
Mantieni accanto a essi la cartella assets/ gia' esistente: contiene le immagini delle pedine.

Avvio locale
------------
1. npm install
2. npm start
3. Apri http://localhost:3000

Deploy su Render
----------------
- Build command: npm install
- Start command: npm start
- Il server ascolta automaticamente process.env.PORT su 0.0.0.0.
- Non serve socket.io-client tra le dipendenze: lo script browser viene servito da Socket.IO.

Regole di sincronizzazione
--------------------------
- Player: l'unica modifica condivisa consentita e' lo spostamento delle pedine PG.
- Pan, zoom e reset vista del Player restano locali e non modificano la stanza.
- Il server rifiuta dal Player modifiche a mappa, griglia, nebbia, disegni, scene, PNG e lista pedine.
- Master -> Player: mappa, griglia, pedine, disegni, nebbia, immagini e cambio scena vengono sincronizzati.
- Player -> Master: i movimenti PG usano preview leggera e commit finale affidabile.

Prestazioni e affidabilita'
---------------------------
- Movimento pedine: preview volatile ogni circa 40 ms e commit finale con ACK.
- Movimento mappa/griglia: delta raggruppati ogni circa 50 ms.
- Nebbia: stroke raggruppati ogni circa 90 ms.
- Disegni, nebbia e movimenti non reinviano lo stato completo della campagna.
- Ogni operazione affidabile ha un ID: un retry non duplica stroke o comandi.
- Se un ACK si perde, il client ritenta automaticamente senza attendere un refresh.
- Dopo una riconnessione il server resta la fonte canonica; il Master non reinvia snapshot vecchi.
- Un controllo di revisione evita di rispedire payload pesanti quando lo stato e' gia' aggiornato.
- Undo/Redo del Master non ripristina coordinate PG modificate successivamente dal Player.
- Sono mantenuti i limiti di sicurezza per punti, disegni, stroke nebbia e numero di pedine.

Test
----
Esegui:
  npm test

La suite automatica verifica, tra l'altro:
- movimento Player -> Master e Master -> Player;
- blocco di tutte le mutazioni Player non consentite;
- mappa, griglia, immagini, reset nebbia, disegni e cambio scena;
- isolamento delle stanze e blocco del cambio ruolo sullo stesso socket;
- assenza della regressione che sovrascriveva i movimenti PG con coordinate vecchie;
- retry idempotente dopo perdita dell'ACK;
- Undo concorrente senza rollback dei movimenti Player;
- payload malformati, limiti di memoria e resync per revisione;
- stress logico con 10.000 movimenti delta.

Test browser opzionale (sviluppo con Python, websockets e Chromium):
  python3 tests/run_browser_smoke.py

Controllo rapido dopo il deploy
-------------------------------
1. Apri due finestre nella stessa stanza: una Master e una Player.
2. Dal Player muovi un PG: il Master deve vederlo; prova un PNG, che non deve muoversi.
3. Dal Master muovi una pedina, sposta mappa/griglia, traccia un disegno e modifica la nebbia: il Player deve ricevere tutto.
4. Disattiva e riattiva per qualche secondo la rete del Player, poi muovi un PG: al ritorno online la posizione finale deve convergere su entrambe le finestre.

Nota persistenza
----------------
Come nella versione originale, lo stato delle stanze resta in memoria. Un riavvio o redeploy del servizio Render azzera lo stato non esportato. Usa "Salva campagna su file" per conservarlo.
