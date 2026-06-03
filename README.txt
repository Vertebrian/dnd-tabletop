BAROVIA VTT - versione room + speed

Novita:
- Stanze indipendenti: ?room=barovia, ?room=marco, ecc.
- Fix movimento PG: se il Player muove una pedina PG, il Master la vede.
- Resize automatico mappa: se l'immagine supera 1500 px di lato, viene ridotta e convertita in JPG.
- Sync piu reattiva: debounce ridotto a 60 ms.

Avvio locale:
1. npm install
2. npm start
3. PC: http://localhost:3000
4. Tablet hotspot: http://192.168.137.1:3000

Uso online:
- Stessa URL, room diversa = partite separate.
- Esempio: https://tuosito.onrender.com/?room=barovia
- Esempio: https://tuosito.onrender.com/?room=dragonlance

File da caricare su Render/GitHub:
- server.js
- package.json
- public/index.html
