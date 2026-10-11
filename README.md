# UHPPOTE Desk

Web app (Node.js + React) per gestire le schede di controllo accessi **UHPPOTE UT0311-L0x** (in particolare la UT0311-L04 a 4 porte), in sostituzione del software Windows "Access Control" (N3000).

Funzioni: rilevamento e configurazione delle schede, persone/tessere/permessi con sincronizzazione automatica, fasce orarie, task programmati, interblocco, anti-passback, tastiere e codici porta, first card, apertura remota, monitor in tempo reale con foto, storico eventi, presenze (turni, festività, ferie, timbrature manuali, report), operatori con ruoli e registro delle operazioni.

L'analisi tecnica completa (protocollo, scelte, rischi) è in [ANALISI.md](ANALISI.md).

## Struttura

| Percorso | Contenuto |
|---|---|
| [packages/protocol](packages/protocol) | Codec TypeScript dei 34 comandi, trasporto UDP/TCP, client con coda per controller, listener eventi, **FakeController** (emulatore per test) |
| [packages/shared](packages/shared) | Schemi zod delle API, DTO, etichette italiane dei codici |
| [apps/server](apps/server) | Backend Fastify: SQLite (`node:sqlite`), autenticazione e ruoli, servizi di sincronizzazione, raccolta eventi, monitoraggio, presenze, WebSocket |
| [apps/web](apps/web) | Frontend React + Mantine |
| [tools/hwtest](tools/hwtest) | Suite di test sulla scheda reale (livelli L0-L5) e simulatore di sviluppo |
| [e2e](e2e) | Test end-to-end Playwright |
| [docker](docker) | Immagine e compose per il NAS |

## Requisiti

- Node.js ≥ 22 (sviluppato con Node 24)
- Per il deploy: Docker con supporto `network_mode: host` (Linux/NAS)

## Sviluppo

```bash
npm install
cp .env.example .env            # configurazione locale
npm run sim                     # terminale 1: controller simulato su 127.0.0.1:60000 (comandi da tastiera: s <tessera> <porta>, o/c <porta>, b <porta>…)
npm run dev                     # terminale 2: server (http://localhost:8080) + web con hot reload (http://localhost:5173)
```

Al primo avvio viene creato l'utente `admin` con la password di `INITIAL_ADMIN_PASSWORD` (va cambiata al primo accesso). In *Controller → Cerca in rete* il simulatore viene trovato come una scheda reale.

## Test

| Comando | Cosa verifica |
|---|---|
| `npm test` | Unit: codec contro i **vettori ufficiali** uhppoted (35 messaggi), test differenziali contro la libreria npm `uhppoted`, codifiche BCD/Wiegand, motore presenze, sync, CSV |
| `npm run test:int` | Integrazione su socket reali: client ↔ FakeController (UDP/TCP, listener, timeout, retry), server end-to-end (API → UDP → eventi → DB → WebSocket), suite hardware contro il simulatore |
| `UHPPOTED_SIM=127.0.0.1 npm run test:int` | In più: test contro il **simulatore ufficiale uhppoted** (implementazione indipendente in Go). Avviarlo prima: `docker compose -f docker/docker-compose.test.yml up -d` oppure, su Windows, `uhppote-simulator.exe --devices <dir>` (release v0.9.0 su codeberg.org/uhppoted/uhppoted-simulator) |
| `npm run e2e` | Playwright: login e cambio password, ricerca e aggiunta controller, persona+tessera+permesso → tessera sulla scheda, monitor live, tutte le pagine senza errori, ruoli |
| `npm run typecheck` | Controllo dei tipi di tutti i pacchetti |

## Collaudo con la scheda reale

La suite `npm run hw` esegue test a livelli, non distruttivi di default (ogni modifica viene ripristinata), e salva un report Markdown + JSON in `reports/`.

```bash
npm run hw -- --help
```

Procedura consigliata all'arrivo della scheda:

1. **Collegamento**: scheda e PC nella stessa rete (stesso switch). Annotare il numero di serie (etichetta S/N, 9 cifre).
2. **Rete e firewall**: consentire su Windows l'UDP in ingresso sulla porta 60001 per Node.js.
3. **Ricerca e IP**: avviare l'app (`npm run dev`), *Controller → Cerca in rete*. Se l'IP di fabbrica non è nella subnet, impostarlo da *Controller → dettaglio → Rete e configurazione → Invia nuovo IP*.
4. **Rete e sola lettura** (L0, L1):
   ```bash
   npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 0,1
   ```
   Il firmware rilevato determina alcune varianti (es. v6.62). Facoltativo: confronto con lo strumento ufficiale `--cli <percorso>/uhppoted-cli.exe`.
5. **Scritture sicure** (L2): ora, listener con ricezione eventi, tessera di test, fascia 254, ritardo porta, segnalibro eventi.
   ```bash
   npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 2
   ```
6. **Prove fisiche guidate** (L3): relè delle 4 porte, tessera autorizzata/non autorizzata, fascia oraria, sensore porta, pulsante uscita, PIN. Servono una tessera (`--user-card`, oppure viene rilevata con uno swipe) e accesso fisico alla scheda.
   ```bash
   npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 3 --user-card 10058400
   ```
7. **Robustezza** (L4): 100 richieste, caricamento massivo (`--bulk 1000`), scollegamento del cavo con swipe offline e recupero, riavvio, raffica di swipe.
8. **Deploy** (L5): sul NAS, dentro il container:
   ```bash
   docker exec -it uhppote-desk node hwtest/cli.js --serial 423187757 --ip 192.168.1.100 --level 5
   ```

## Installazione con Docker

L'immagine pronta è `ghcr.io/alexbn71/uhppote-desk:latest`. La guida completa è in **[docs/DOCKER.md](docs/DOCKER.md)**: requisiti di rete (rete `host` obbligatoria), elenco delle variabili d'ambiente, esempi per Docker Compose, `docker run`, Unraid, Synology e QNAP, primo avvio, aggiornamenti e problemi frequenti.

In breve, l'unica variabile obbligatoria è `UHPPOTE_LISTENER_PUBLIC` (IP:porta del server come lo vedono le schede, es. `192.168.1.10:60001`); è consigliato impostare anche `UHPPOTE_BROADCAST` (broadcast della subnet delle schede, es. `192.168.1.255:60000`) e `TZ`.

Per lo sviluppo locale si usano le stesse variabili, in un file `.env` nella root del progetto (vedi `.env.example`).

## Riferimenti

- Protocollo e strumenti: progetto [uhppoted](https://codeberg.org/uhppoted) (MIT). I vettori di test in `packages/protocol/test/fixtures` provengono da `uhppoted-codegen`.
- Manuale e software originale (non inclusi nel repository): software http://www.wiegand.com.cn/soft/soft_all_32/MJ_all_en.rar, da collocare localmente in `Legacy/` (ignorata da git).
