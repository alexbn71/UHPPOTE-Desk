# Installazione con Docker

Questa guida spiega come installare UHPPOTE Desk con Docker su un server o un NAS e come configurarlo per la propria rete. Non c'è niente da compilare: si usa l'immagine già pronta.

## Immagine

| | |
|---|---|
| Immagine | `ghcr.io/alexbn71/uhppote-desk` |
| Tag | `latest` (ultima versione di `main`), `sha-<commit>` (versione precisa), `<x.y.z>` (release) |
| Architettura | `linux/amd64` |
| Porte | `8080/tcp` interfaccia web (configurabile) · `60001/udp` ricezione eventi dalle schede |
| Volume | `/data`: database, backup, foto, report dei test |
| Utente | `node` (UID 1000), modificabile con `--user` |

L'immagine viene costruita e verificata da GitHub Actions a ogni modifica: test, avvio di prova del container, pubblicazione.

## Requisiti di rete (importante)

Il server e le schede comunicano in **UDP**. Per questo servono alcune condizioni:

1. **Il container deve usare la rete `host`** (`network_mode: host` / `--network host`).
   Con la rete bridge di Docker la ricerca delle schede (broadcast) non esce dal container e gli eventi che le schede inviano al server non arrivano. Mappare le porte non basta.
2. **Il server e le schede devono stare nella stessa rete locale**, cioè nella stessa subnet, per poter cercare le schede in automatico. Se le schede sono su un'altra subnet funziona comunque, ma il loro indirizzo IP va inserito a mano nell'app.
3. **Firewall**: devono essere aperte la porta UDP in ingresso `60001`, o quella indicata in `UHPPOTE_LISTEN`, e la porta TCP dell'interfaccia web.
4. **Sicurezza**: il protocollo delle schede non è né autenticato né cifrato. È consigliabile mettere schede e server in una rete (VLAN) separata e rendere raggiungibile l'interfaccia web solo dalla rete locale o via VPN.

## Variabili d'ambiente

Nei valori di esempio il server ha IP `192.168.1.10` e le schede sono nella subnet `192.168.1.0/24`. Vanno sostituiti con quelli della propria rete.

### Obbligatoria

| Variabile | Descrizione | Esempio |
|---|---|---|
| `UHPPOTE_LISTENER_PUBLIC` | Indirizzo `IP:porta` **di questo server** come lo vedono le schede. Viene scritto nelle schede come destinazione degli eventi. Senza questa variabile gli eventi arrivano lo stesso, ma con ritardo, tramite il controllo periodico. | `192.168.1.10:60001` |

### Consigliate

| Variabile | Default | Descrizione | Esempio |
|---|---|---|---|
| `UHPPOTE_BROADCAST` | `255.255.255.255:60000` | Indirizzo di broadcast usato per cercare le schede. Conviene indicare quello della subnet delle schede: sui server con più interfacce di rete (NAS, Unraid, host con Docker o VM) l'indirizzo generico può uscire dall'interfaccia sbagliata. | `192.168.1.255:60000` |
| `INITIAL_ADMIN_PASSWORD` | generata | Password dell'utente `admin`, usata solo al primo avvio. Al primo accesso viene chiesto di cambiarla. Se la variabile è vuota, la password viene generata e scritta nel log del container. | — |
| `TZ` | ora del sistema | Fuso orario. Determina l'ora impostata sulle schede e l'orario dei report. | `Europe/Rome` |
| `HTTP_PORT` | `8080` | Porta dell'interfaccia web. Con la rete `host` non deve essere già usata da un altro servizio. | `8080` |

### Facoltative

| Variabile | Default | Descrizione |
|---|---|---|
| `UHPPOTE_BIND_ADDR` | `0.0.0.0` | IP locale da usare per comunicare con le schede. Va indicato quando il server ha più interfacce di rete e si vuole usarne una sola (es. `192.168.1.10`). |
| `UHPPOTE_LISTEN` | `0.0.0.0:60001` | Indirizzo e porta UDP su cui ricevere gli eventi. Se si cambia la porta, va cambiata anche in `UHPPOTE_LISTENER_PUBLIC`. |
| `UHPPOTE_TIMEOUT_MS` | `2500` | Tempo massimo di attesa di una risposta dalla scheda. |
| `UHPPOTE_RETRIES` | `1` | Tentativi aggiuntivi dopo un timeout. Si applicano solo alle operazioni ripetibili senza effetti collaterali; l'apertura porta non viene mai ripetuta. |
| `UHPPOTE_DEBUG` | `false` | `true` scrive nel log, in esadecimale, tutti i pacchetti scambiati con le schede (per la diagnosi). |
| `SECURE_COOKIES` | `false` | `true` se l'interfaccia è pubblicata in HTTPS tramite reverse proxy. |
| `SESSION_HOURS` | `12` | Durata della sessione degli operatori. |
| `HEALTH_INTERVAL_SEC` | `15` | Intervallo di controllo dello stato delle schede (online/offline, porte). |
| `COLLECT_INTERVAL_SEC` | `300` | Intervallo con cui gli eventi vengono anche scaricati dalla scheda, come sicurezza nel caso un evento in tempo reale vada perso. |
| `TIME_SYNC_THRESHOLD_SEC` | `30` | Differenza in secondi oltre la quale l'ora della scheda viene corretta automaticamente (`0` = mai). |
| `INITIAL_BACKFILL` | `5000` | Numero di eventi già presenti sulla scheda da importare la prima volta che viene collegata. |
| `BACKUP_HOUR` | `2` | Ora del backup giornaliero del database (`-1` = disattivato). |
| `BACKUP_KEEP` | `14` | Numero di backup da conservare. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Già impostate nell'immagine (non modificare)

| Variabile | Valore |
|---|---|
| `DATA_DIR` | `/data` |
| `WEB_DIR` | `/app/web` |
| `HWTEST_REPORT_DIR` | `/data/reports` |
| `NODE_ENV` | `production` |

## Installazione con Docker Compose

Si usano i file [docker/docker-compose.yml](../docker/docker-compose.yml) e [docker/.env.example](../docker/.env.example):

```bash
git clone https://github.com/alexbn71/UHPPOTE-Desk.git
cd UHPPOTE-Desk/docker
cp .env.example .env
# modificare .env: almeno UHPPOTE_LISTENER_PUBLIC e UHPPOTE_BROADCAST
docker compose up -d
docker logs uhppote-desk          # password di admin, se generata
```

Esempio minimo di `docker-compose.yml`, se non si clona il repository:

```yaml
services:
  uhppote-desk:
    image: ghcr.io/alexbn71/uhppote-desk:latest
    container_name: uhppote-desk
    restart: unless-stopped
    network_mode: host
    environment:
      UHPPOTE_LISTENER_PUBLIC: 192.168.1.10:60001
      UHPPOTE_BROADCAST: 192.168.1.255:60000
      TZ: Europe/Rome
    volumes:
      - ./data:/data
```

> Se si monta una cartella dell'host come `/data`, il container (utente UID 1000) deve poterci scrivere: `chown -R 1000:1000 ./data`, oppure avviare il container con l'utente proprietario della cartella (`user: "UID:GID"`).

## Installazione con `docker run`

```bash
docker run -d --name uhppote-desk --restart unless-stopped \
  --network host \
  -e UHPPOTE_LISTENER_PUBLIC=192.168.1.10:60001 \
  -e UHPPOTE_BROADCAST=192.168.1.255:60000 \
  -e TZ=Europe/Rome \
  -v uhppote-desk-data:/data \
  ghcr.io/alexbn71/uhppote-desk:latest
```

## Installazione su Unraid

1. Dal terminale di Unraid scaricare il template:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-uhppote-desk.xml \
     https://raw.githubusercontent.com/alexbn71/UHPPOTE-Desk/main/docker/unraid/uhppote-desk.xml
   ```
2. **Docker → Add Container → Template: uhppote-desk**.
3. Compilare almeno **Destinazione eventi** (`UHPPOTE_LISTENER_PUBLIC`) e **Broadcast ricerca** (`UHPPOTE_BROADCAST`), e controllare che la **Porta web** sia libera. Le altre variabili sono nella sezione *Show more settings*.
4. Il template imposta già:
   - **rete `host`**;
   - **cartella dati** `/mnt/user/appdata/uhppote-desk` montata in `/data`;
   - **utente `99:100`** (`nobody:users`), così il container può scrivere in `appdata`.
5. **Apply**, poi aprire la WebUI dall'icona del container.

## Altri NAS

- **Synology (Container Manager)**: creare un *Progetto* con il `docker-compose.yml` d'esempio. La modalità `network_mode: host` è supportata.
- **QNAP (Container Station)**: creare un'applicazione dal compose d'esempio, oppure usare la rete *Host* nella creazione manuale.

Su entrambi bisogna controllare che la cartella dati sia scrivibile dall'utente del container (vedi la nota nella sezione Docker Compose).

## Primo avvio

1. Aprire `http://<IP-del-server>:<HTTP_PORT>` e accedere come `admin`, con la password iniziale. Viene chiesta subito una password nuova.
2. **Controller → Cerca in rete**: le schede raggiungibili via broadcast compaiono con numero di serie, IP e firmware. Con **Aggiungi** si registrano nell'app.
3. Appena una scheda risulta online, l'app le invia la destinazione degli eventi (`UHPPOTE_LISTENER_PUBLIC`) e ne sincronizza l'ora. Lo si può verificare in **Controller → dettaglio → Diagnostica** alla voce "Listener eventi".

## Collaudo dal container

La suite di test hardware è inclusa nell'immagine:

```bash
docker exec -it uhppote-desk node hwtest/cli.js --help
docker exec -it uhppote-desk node hwtest/cli.js --serial <S/N> --ip <IP scheda> --level 0,1
docker exec -it uhppote-desk node hwtest/cli.js --serial <S/N> --ip <IP scheda> --level 5   # verifica completa del deploy
```

I report vengono salvati in `/data/reports`. La descrizione dei livelli di test è nel [README](../README.md#collaudo-con-la-scheda-reale).

## Aggiornamento e backup

- **Aggiornare**: `docker compose pull && docker compose up -d`. Su Unraid: *Check for updates* → *Update*. Il database si aggiorna da solo all'avvio.
- **Backup automatico**: ogni giorno all'ora `BACKUP_HOUR` in `/data/backups`, oppure a mano da *Sistema → Crea backup ora*. Per un backup completo basta copiare la cartella dati.
- Prima di un ripristino di fabbrica di una scheda, le sue tessere vengono salvate in `/data/backups/cards-<seriale>-<data>.json`.

## Problemi frequenti

| Sintomo | Causa probabile | Soluzione |
|---|---|---|
| La ricerca in rete non trova schede | Il container non usa la rete `host`, la scheda è su un'altra subnet, o il broadcast esce dall'interfaccia sbagliata | Usare la rete `host`; impostare `UHPPOTE_BROADCAST` sul broadcast della subnet e/o `UHPPOTE_BIND_ADDR`; in alternativa aggiungere la scheda a mano con il suo IP |
| Scheda online ma eventi in ritardo (solo ogni `COLLECT_INTERVAL_SEC`) | `UHPPOTE_LISTENER_PUBLIC` mancante o errato, oppure porta UDP 60001 bloccata | Controllare in *Diagnostica* che "Listener eventi" mostri l'IP del server; aprire la porta UDP 60001 sul firewall |
| Avviso nel log "UHPPOTE_LISTENER_PUBLIC non impostato" | Variabile mancante | Impostarla e riavviare il container |
| Nel log: "impossibile avviare il listener eventi" (il server parte ma gli eventi arrivano solo ogni `COLLECT_INTERVAL_SEC`) | Un altro servizio usa già la porta UDP 60001 | Cambiare `UHPPOTE_LISTEN` e `UHPPOTE_LISTENER_PUBLIC` |
| Errore all'avvio sul database / permessi in `/data` | La cartella dati non è scrivibile dall'utente del container | Correggere i permessi oppure usare `--user` (vedi sopra) |
| L'interfaccia web non si apre | Porta occupata o bloccata dal firewall | Cambiare `HTTP_PORT` |
| Ora errata sulle schede o nei report | `TZ` non impostata | Impostare `TZ`, es. `Europe/Rome` |
