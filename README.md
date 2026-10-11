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

## Deploy su NAS (Docker)

L'immagine viene costruita e testata da GitHub Actions a ogni push su `main` e pubblicata come `ghcr.io/alexbn71/uhppote-desk:latest` (linux/amd64).

### Unraid

1. Copiare [docker/unraid/uhppote-desk.xml](docker/unraid/uhppote-desk.xml) in `/boot/config/plugins/dockerMan/templates-user/my-uhppote-desk.xml` (es. dal terminale di Unraid:
   `wget -O /boot/config/plugins/dockerMan/templates-user/my-uhppote-desk.xml https://raw.githubusercontent.com/alexbn71/UHPPOTE-Desk/main/docker/unraid/uhppote-desk.xml`).
2. *Docker → Add Container → Template: uhppote-desk*, verificare i valori (IP 192.168.178.61, broadcast 192.168.178.255, porta web libera) e applicare.
3. Il container gira come `nobody:users` (99:100), i dati sono in `/mnt/user/appdata/uhppote-desk`.
4. Interfaccia: `http://192.168.178.61:8080` — password iniziale di `admin` nel log del container se non impostata.

### Docker Compose

```bash
cp docker/.env.example docker/.env       # impostare UHPPOTE_LISTENER_PUBLIC con l'IP del NAS, broadcast di subnet, password admin
docker compose -f docker/docker-compose.yml up -d
docker logs uhppote-desk                 # password admin generata (se non impostata)
```

- `network_mode: host` è **necessario**: con la rete bridge di Docker il broadcast non esce e gli eventi UDP delle schede non arrivano.
- Dati (database, backup giornalieri, foto) nel volume `/data`.
- Esporre l'interfaccia solo in LAN/VPN; per HTTPS usare il reverse proxy del NAS e impostare `SECURE_COOKIES=true`.
- Il protocollo delle schede non è autenticato né cifrato: si consiglia una VLAN dedicata per schede e NAS.

## Variabili di configurazione

| Variabile | Default | Descrizione |
|---|---|---|
| `HTTP_PORT` / `HTTP_HOST` | `8080` / `0.0.0.0` | Interfaccia web |
| `DATA_DIR` | `./data` | Database SQLite, backup |
| `WEB_DIR` | — | Cartella del frontend compilato (in Docker `/app/web`) |
| `INITIAL_ADMIN_PASSWORD` | generata | Password del primo `admin` |
| `SECURE_COOKIES` | `false` | Cookie solo HTTPS |
| `SESSION_HOURS` | `12` | Durata della sessione |
| `UHPPOTE_BIND_ADDR` | `0.0.0.0` | IP locale verso le schede (indicarlo su host con più interfacce) |
| `UHPPOTE_BROADCAST` | `255.255.255.255:60000` | Broadcast per la ricerca (meglio quello di subnet, es. `192.168.1.255:60000`) |
| `UHPPOTE_LISTEN` | `0.0.0.0:60001` | Dove ricevere gli eventi |
| `UHPPOTE_LISTENER_PUBLIC` | — | IP:porta di questo server, programmato nelle schede come destinazione eventi |
| `UHPPOTE_TIMEOUT_MS` / `UHPPOTE_RETRIES` | `2500` / `1` | Timeout e tentativi (solo operazioni idempotenti) |
| `UHPPOTE_DEBUG` | `false` | Log esadecimale di tutti i pacchetti |
| `HEALTH_INTERVAL_SEC` | `15` | Polling dello stato delle schede |
| `COLLECT_INTERVAL_SEC` | `300` | Raccolta eventi di sicurezza (oltre al push) |
| `TIME_SYNC_THRESHOLD_SEC` | `30` | Deriva oltre la quale l'ora della scheda viene corretta |
| `INITIAL_BACKFILL` | `5000` | Eventi storici scaricati al primo collegamento |
| `BACKUP_HOUR` / `BACKUP_KEEP` | `2` / `14` | Backup giornaliero del database (−1 = disattivato) |

## Riferimenti

- Protocollo e strumenti: progetto [uhppoted](https://codeberg.org/uhppoted) (MIT). I vettori di test in `packages/protocol/test/fixtures` provengono da `uhppoted-codegen`.
- Manuale e software originale (non inclusi nel repository): software http://www.wiegand.com.cn/soft/soft_all_32/MJ_all_en.rar, da collocare localmente in `Legacy/` (ignorata da git).
