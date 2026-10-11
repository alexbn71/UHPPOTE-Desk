# UHPPOTE-Desk — Analisi tecnica

> Report di analisi per lo sviluppo di una web app (Node.js + React) che sostituisca il software Windows "Access Control" (N3000) per la scheda di controllo accessi **UHPPOTE UT0311-L04** (4 porte).
> Data: 11/10/2026 · Stato: analisi completata, scheda fisica non ancora disponibile.

---

## 1. Sommario

| Tema | Conclusione |
|---|---|
| Comunicazione | Protocollo proprietario binario su **UDP porta 60000**, pacchetti fissi da **64 byte**, request/response; la scheda può inoltre **spingere eventi** (UDP) verso **un** host configurato. I firmware recenti accettano gli stessi frame anche su **TCP 60000**. |
| Documentazione protocollo | Il produttore non pubblica la specifica. La fonte autorevole pubblica è il progetto open-source **uhppoted** (Codeberg), che ha fatto reverse engineering di tutti i 34 comandi e pubblica un **modello JSON con offset** e **vettori di test** binari ufficiali. |
| Manuale fornito | Descrive solo l'interfaccia del software N3000 → serve a definire il **perimetro funzionale**, non il protocollo. |
| Libreria Node esistente | npm `uhppoted` 0.9.1 (MIT) copre tutto il protocollo ma presenta alcuni difetti verificati nel sorgente (§7.2). **Decisione**: codec + trasporto **TypeScript nostro** (≈ 800 righe, completamente testabile), validato byte-per-byte contro i vettori ufficiali e con test differenziali contro la libreria `uhppoted`. |
| Test senza hardware | **uhppoted-simulator** (Docker, emula UT0311-L04, REST per simulare tessere/porte) consente test di integrazione completi prima dell'arrivo della scheda. |
| Deploy | Container Docker sul NAS con **`network_mode: host`** (indispensabile per broadcast e ricezione eventi UDP). |
| Stack | Monorepo TypeScript: Fastify + SQLite (Drizzle) + WebSocket lato server, React + Vite + Mantine lato client. |

---

## 2. Fonti analizzate

| Fonte | Contenuto | Utilità |
|---|---|---|
| `Legacy/Docs/D15YWUBvgTS.pdf` | "Access Control Software Operation Guide" UHPPOTE, 72 pagine | Perimetro funzionale, terminologia, note hardware (FAQ) |
| `Legacy/Software/MJ_all_en.rar` | `N3000.exe` (.NET), `n3k_comm.dll` (comunicazione), `n3k_jm.dll`, `SqlSet.exe`, `n3k.msi`, driver USB FTDI (lettore USB WG1028), `Readme.doc` | Conferma architettura legacy (WinForms + Access/SQL Server). Non è necessario decompilare `n3k_comm.dll`: il protocollo è già documentato da uhppoted |
| `Informazioni.MD` → [node-red-contrib-uhppoted](https://flows.nodered.org/node/node-red-contrib-uhppoted) | Nodo Node-RED (v1.1.14, 09/2026), 37 nodi | Prova che il protocollo funziona da Node.js; contiene una copia del codec JS |
| [codeberg.org/uhppoted/uhppoted-lib-node-red](https://codeberg.org/uhppoted/uhppoted-lib-node-red) | Sorgente del nodo Node-RED | Riferimento |
| [codeberg.org/uhppoted](https://codeberg.org/uhppoted) | Organizzazione: `uhppoted-core` (Go, implementazione di riferimento), `uhppoted-lib-nodejs` (npm `uhppoted`), `uhppoted-codegen` (modello + vettori), `uhppoted-simulator`, `uhppoted-cli`, `uhppoted-rest`, `uhppoted-mqtt`, `uhppoted-httpd`, `uhppoted-tunnel` | Specifica del protocollo, strumenti di test |
| `uhppoted-codegen/bindings/.models/models.json` | Modello di ogni request/response con **nome, offset, tipo** | Fonte primaria delle tabelle in §5 |
| `uhppoted-codegen/bindings/.models/test-data.json` | **35 vettori di test** (pacchetti base64 + valori attesi) per ogni comando | Golden test del nostro codec |
| npm `uhppoted@0.9.1` (sorgente letto integralmente) | `encoder.js`, `decoder.js`, `driver.js`, `lookup.js`, `common.js` | Verifica incrociata layout, individuazione difetti |

> Nota: i mirror GitHub di uhppoted (`github.com/uhppoted/...`) ora rispondono 404; il progetto è interamente su Codeberg e diversi repository sono stati rinominati (`uhppote-*` → `uhppoted-*`).

---

## 3. Hardware: UHPPOTE UT0311-L04

| Caratteristica | Valore |
|---|---|
| Porte / relè | 4 porte, 4 relè serratura |
| Lettori | 4 ingressi Wiegand (uno per porta; i modelli L01/L02 usano lettori in/out) |
| Ingressi | sensore porta ×4, pulsante uscita ×4, ingressi ausiliari (forzatura/incendio) |
| Formato tessere | **solo Wiegand-26** (facility 0–255 + numero 0–65535). Numero "a 8 cifre" = `facility × 100000 + numero` (es. `10058400` → facility 100, numero 58400). Il numero stampato su alcune tessere (10 cifre) **non coincide**: va letto passando la tessera (FAQ manuale, p. 71). |
| Capacità | 20.000 tessere, 100.000 eventi dichiarati (uhppoted ha osservato ~200.000) |
| Rete | Ethernet 10/100, IP statico configurabile via protocollo; identificata dal **numero di serie a 9 cifre** riportato sull'etichetta |
| Firmware | Non aggiornabile dall'utente. uhppoted: minimo supportato v6.56, diffuso v6.62, sviluppo su v8.92. **v9.158**: possibile bug sulla cancellazione tessere |
| Credenziali legacy | Software N3000: utente `abc` / pwd `123`, funzioni estese `5678`, registrazione `2004`, DB Access `iCCard3000.mdb` pwd `168168` |
| Avvertenza | "WEB configure software" e software di gestione **non vanno usati insieme** (FAQ 6) — vale anche per la nostra app: un solo sistema di gestione attivo per volta, soprattutto per il listener eventi (unico per scheda) |

---

## 4. Software legacy: perimetro funzionale e mappatura

| Funzione N3000 (manuale) | Scope v1 | Implementazione nella nuova app | Comandi protocollo |
|---|---|---|---|
| 2.2.1 Aggiungi controller (S/N) | ✅ | Anagrafica controller, discovery | `0x94` |
| 2.2.2 Ricerca + configura IP | ✅ | Pagina Controller: ricerca broadcast, impostazione IP/maschera/gateway | `0x94`, `0x96` |
| 2.2.3 Zone | ✅ | Zone gerarchiche (anche per permessi operatori) | — (solo DB) |
| 2.3.1 Reparti | ✅ | Albero reparti | — |
| 2.3.2 Utenti (personale) | ✅ | Persone + tessere, foto | — |
| 2.3.3 Aggiunta automatica tessere (lettore USB / swipe su controller / batch) | ✅ (swipe + batch) | "Passa la tessera": cattura dall'evento di swipe negato; inserimento intervallo | eventi `0x20` |
| 2.3.5 Tessera smarrita | ✅ | Sostituzione tessera con upload immediato | `0x52`, `0x50` |
| 2.4.1 Privilegi di accesso | ✅ | Matrice persone × porte (sempre / fascia oraria) | `0x50` |
| 2.5.1 Console → Check | ✅ | Dashboard: stato porte, conteggi, online/offline | `0x20`, `0x58`, `0x82` |
| 2.5.1 Regola ora | ✅ | Sincronizzazione ora (manuale + automatica) | `0x30`, `0x32` |
| 2.5.2 Upload | ✅ | Sincronizzazione con **anteprima delle differenze** | `0x50`, `0x52`, `0x5C`… |
| 2.5.3 Monitor | ✅ | Monitor live via WebSocket con foto | eventi `0x20` |
| 2.5.5 Download registrazioni | ✅ | Raccolta eventi incrementale per indice (automatica) | `0xB4`, `0xB0`, `0xB2` |
| 2.6 Ricerca registrazioni | ✅ | Storico eventi con filtri + export CSV | — |
| 2.7.1 Operatori/password | ✅ | Operatori con ruoli + audit log | — |
| 2.7.2 Backup DB | ✅ | Backup SQLite programmato | — |
| 3.2.1 Registra eventi pulsante / 3.2.2 eventi porta | ✅ | Flag "eventi speciali" | `0x8E` |
| 3.2.3 Fasce orarie (time profile, link) | ✅ | Profili 2–254, 3 segmenti, giorni, validità, concatenazione | `0x88`, `0x98`, `0x8A` |
| 3.2.4 Periferiche (allarmi) | ⚠️ parziale | Solo visualizzazione ingressi/allarmi da status; il protocollo noto non espone la configurazione delle uscite di allarme | `0x20` |
| 3.2.5 Tastiera/PIN (card+PIN, PIN porta, super password) | ✅ | Attivazione keypad, PIN per tessera, fino a 4 passcode per porta | `0xA4`, `0x8C`, `0x50` |
| 3.2.6 Anti-passback | ✅ | 5 modalità | `0x84`, `0x86` |
| 3.2.7 Interblocco | ✅ | 6 modalità | `0xA2` |
| 3.2.8 Multi-card | ⚠️ | Solo via task "abilita/disabilita more cards" (`more cards` count); la definizione dei gruppi non è nel protocollo noto | `0xA8` |
| 3.2.9 First card open | ✅ | Per porta, orari e modalità attiva/inattiva | `0xAA`, flag in `0x50` |
| 3.2.10 Task list | ✅ | 13 tipi di task programmati | `0xA6`, `0xA8`, `0xAC` |
| 3.3.1 Apertura remota | ✅ | Pulsante apri porta (con conferma e audit) | `0x40` |
| 3.4.1–3.4.3 Mensa / Ronda / Riunioni | ❌ | Fuori scope v1 | — |
| 3.4.4 One-to-more (ascensori) | ❌ | Fuori scope | — |
| 3.5.1 Gestione operatori/privilegi | ✅ | Ruoli admin/operatore/sola lettura, permessi per zona | — |
| 4.x Presenze (turni, festività, ferie, timbrature manuali, report) | ✅ | Motore presenze calcolato dagli eventi di swipe sui lettori marcati "presenze" | — |
| 5.3 Import da Excel | ✅ | Import CSV/XLSX (matricola, nome, tessera, reparto con separatore `\`) | — |

Funzionalità aggiuntive non presenti nel protocollo noto ma utili: **PC control** (`0xA0`: la scheda delega le decisioni all'host; se non riceve comunicazioni per 30 s torna autonoma) — previsto solo come opzione avanzata, disattivato di default.

---

## 5. Protocollo di comunicazione

### 5.1 Trasporto

| Aspetto | Dettaglio |
|---|---|
| Porta scheda | **UDP 60000** (anche **TCP 60000** sui firmware recenti, stessi frame) |
| Dimensione | **64 byte** fissi, sia request che response; qualsiasi altra lunghezza è invalida |
| Modello | Request/response 1:1. La scheda risponde all'**indirizzo:porta sorgente** della richiesta → il client usa un socket con porta effimera e legge lì la risposta |
| Discovery | `0x94` con seriale **0** inviato in **broadcast** (`255.255.255.255:60000` o broadcast di subnet): rispondono tutte le schede del segmento L2 |
| Unicast | Dopo aver configurato l'IP, i comandi si inviano direttamente a `IP:60000` (consigliato: niente broadcast, niente problemi multi-NIC) |
| Set IP (`0x96`) | **Nessuna risposta**. Dopo il comando la scheda risponde solo sul nuovo IP → verificare con un `0x94` successivo |
| Eventi push | La scheda invia pacchetti `0x20` (stesso layout di Get Status) all'unico **listener** configurato (`0x90`: IPv4 + porta + intervallo auto-send 0–255 s, 0 = solo su evento). Porta convenzionale host: **60001** |
| Timeout | Nessuna ritrasmissione nel protocollo. Riferimenti: CLI 2,5 s; libreria Node 5 s. Noi: 2,5 s + 1 retry per le letture idempotenti, nessun retry automatico per le scritture non idempotenti (es. apertura porta) |
| Trappola porta effimera | Se il SO assegna al socket client proprio la porta 60000, il client riceve il proprio broadcast come se fosse una risposta → scartare e ripetere il bind |

### 5.2 Struttura del frame

| Offset | Lung. | Campo |
|---|---|---|
| 0 | 1 | Start of message **`0x17`** (eccezione: firmware **v6.62** invia gli eventi listener con **`0x19`**; accettarlo solo se il function code è `0x20`) |
| 1 | 1 | **Function code** |
| 2 | 2 | Riservato (`00 00`) |
| 4 | 4 | **Numero di serie** controller, uint32 **little-endian** (0 in discovery) |
| 8 | 56 | Payload specifico, riempito con zeri |

Esempio ufficiale (get controller, seriale 405419896): `17 94 00 00 78 37 2a 18 00 …` (64 byte).

### 5.3 Codifica dei tipi

| Tipo | Codifica |
|---|---|
| uint8/16/32 | little-endian |
| bool | `0x00` / `0x01` (altri valori = errore) |
| **date** | 4 byte BCD `YYYYMMDD` (es. `20 26 10 11`). `00000000` = assente |
| **datetime** | 7 byte BCD `YYYYMMDDHHmmss`. Tutto zero = assente |
| shortdate (status) | 3 byte BCD `YYMMDD` (secolo implicito 20) |
| time (status) | 3 byte BCD `HHmmss` |
| HHmm | 2 byte BCD `HHMM` |
| IPv4 | 4 byte in ordine di rete (`c0 a8 01 64` = 192.168.1.100) |
| MAC | 6 byte |
| version | 2 byte BCD → `v8.92` da `08 92` |
| PIN | uint24 LE (3 byte) nelle tessere, uint32 LE nei passcode porta; range 0–999999, 0 = nessuno |
| magic | uint32 **`0x55AAAA55`** (byte `55 aa aa 55`) richiesto dai comandi distruttivi/di configurazione |

### 5.4 Elenco comandi (request)

Offset ≥ 8 (byte 0–7 = header sopra).

| Code | Comando | Campi request |
|---|---|---|
| `0x94` | Get controller (discovery) | — |
| `0x96` | Set IPv4 | 8 IP · 12 netmask · 16 gateway · 20 magic — **nessuna risposta** |
| `0x32` | Get time | — |
| `0x30` | Set time | 8 datetime |
| `0x92` | Get listener | — |
| `0x90` | Set listener | 8 IPv4 · 12 porta u16 · 14 intervallo auto-send u8 |
| `0x82` | Get door control | 8 porta |
| `0x80` | Set door control | 8 porta · 9 modalità (1 NA, 2 NC, 3 controllata) · 10 ritardo s (u8) |
| `0x8C` | Set door passcodes | 8 porta · 12/16/20/24 passcode 1–4 (u32, 0–999999) |
| `0x40` | Open door | 8 porta |
| `0x20` | Get status | — |
| `0x58` | Get cards (conteggio) | — |
| `0x5A` | Get card (per numero) | 8 numero tessera |
| `0x5C` | Get card at index | 8 indice (da 1) |
| `0x50` | Put card | 8 tessera · 12 data inizio · 16 data fine · 20–23 porte 1–4 (0 nessuno, 1 sempre, 2–254 profilo orario) · 24 PIN (3 byte) · 27 bitmask first-card (bit0 = porta 1 … bit3 = porta 4) |
| `0x52` | Delete card | 8 tessera |
| `0x54` | Delete all cards | 8 magic |
| `0xB0` | Get event | 8 indice |
| `0xB4` | Get event index (ultimo scaricato) | — |
| `0xB2` | Set event index | 8 indice · 12 magic |
| `0x8E` | Record special events | 8 bool |
| `0x98` | Get time profile | 8 ID profilo |
| `0x88` | Set time profile | 8 ID (2–254) · 9 data inizio · 13 data fine · 17–23 lun…dom · 24/26 seg.1 inizio/fine · 28/30 seg.2 · 32/34 seg.3 (HHmm) · 36 profilo collegato (0 = nessuno) |
| `0x8A` | Clear time profiles | 8 magic |
| `0xA8` | Add task | 8 data inizio · 12 data fine · 16–22 lun…dom · 23 ora inizio HHmm · 25 porta · 26 tipo task · 27 "more cards" |
| `0xAC` | Refresh task list | 8 magic |
| `0xA6` | Clear task list | 8 magic |
| `0xA0` | Set PC control | 8 magic · 12 bool |
| `0xA2` | Set interlock | 8 modalità |
| `0xA4` | Activate keypads | 8–11 lettore 1–4 bool |
| `0x86` | Get anti-passback | — |
| `0x84` | Set anti-passback | 8 modalità |
| `0xAA` | Set first-card | 8 porta · 9 ora inizio · 11 modalità attiva · 12 ora fine · 14 modalità inattiva · 15–21 lun…dom |
| `0xC8` | Restore default parameters | 8 magic |

### 5.5 Risposte

| Code | Campi response |
|---|---|
| `0x94` | 8 IP · 12 netmask · 16 gateway · 20 MAC · 26 versione · 28 data firmware |
| `0x32`/`0x30` | 8 datetime corrente |
| `0x92` | 8 IPv4 · 12 porta · 14 intervallo |
| `0x82`/`0x80` | 8 porta · 9 modalità · 10 ritardo |
| `0x58` | 8 numero tessere (u32) |
| `0x5A`/`0x5C` | stesso layout di Put card (8–27). Tessera **0** = non trovata; tessera **0xFFFFFFFF** = record cancellato (tombstone) |
| `0xB0` | 8 indice · 12 tipo · 13 consentito · 14 porta · 15 direzione · 16 tessera · 20 timestamp · 27 motivo |
| `0xB4` | 8 indice |
| `0x98` | stesso layout di Set time profile; ID 0 = non trovato |
| `0x86` | 8 modalità anti-passback |
| tutti gli altri | 8 `ok` bool |

### 5.6 Get Status / evento push (`0x20`)

| Offset | Campo |
|---|---|
| 8 | indice ultimo evento (u32; 0 = nessun evento) |
| 12 | tipo evento |
| 13 | accesso consentito (bool) |
| 14 | porta (1–4) |
| 15 | direzione (1 ingresso, 2 uscita) |
| 16 | numero tessera (u32) |
| 20 | timestamp evento (datetime, opzionale) |
| 27 | codice motivo |
| 28–31 | sensore porta 1–4 aperto |
| 32–35 | pulsante porta 1–4 premuto |
| 36 | errore di sistema |
| 37 | ora scheda HHmmss |
| 40 | numero di sequenza (u32) |
| 48 | special info |
| 49 | **relè**: bitmask bit0–3 = porta 1–4 (1 = sbloccata) |
| 50 | **ingressi**: bit0 = lock forzato, bit1 = allarme incendio |
| 51 | data scheda YYMMDD |

### 5.7 Tabelle di codici

**Tipo evento**: 0 nessuno · 1 tessera · 2 porta · 3 allarme · 255 sovrascritto.

**Motivi (reason)**:

| Cod. | Significato | Cod. | Significato |
|---|---|---|---|
| 1 | swipe | 23 | porta aperta |
| 2 | swipe apertura | 24 | porta chiusa |
| 3 | swipe chiusura | 25 | porta aperta (password supervisore) |
| 5 | negato (gestito dal sistema/PC control) | 28 | accensione controller |
| 6 | nessun diritto di accesso | 29 | reset controller |
| 7 | password errata | 31 | pulsante non valido (porta bloccata) |
| 8 | anti-passback | 32 | pulsante non valido (offline) |
| 9 | more cards (multi-card) | 33 | pulsante non valido (interblocco) |
| 10 | first card open | 34 | pulsante non valido (minaccia) |
| 11 | porta normalmente chiusa | 37 | porta aperta troppo a lungo |
| 12 | interblocco | 38 | apertura forzata |
| 13 | fuori fascia oraria | 39 | incendio |
| 15 | fuso orario non valido | 40 | chiusura forzata |
| 18 | accesso negato | 41 | antifurto |
| 20 | pulsante uscita OK | 42 | zona 24×7 |
|  |  | 43 | emergenza |
|  |  | 44 | apertura remota |
|  |  | 45 | apertura remota (lettore USB) |

Codici non elencati = riservati (mostrare il valore numerico).

**Modalità porta** (`0x80`/`0x82`): 1 normalmente aperta · 2 normalmente chiusa · 3 controllata.
**Modalità first-card** (`0xAA`, codifica diversa!): 0 controllata · 1 NA · 2 NC · 3 solo first-card (ammessa solo come modalità inattiva).
**Interblocco**: 0 nessuno · 1 porte 1&2 · 2 porte 3&4 · 3 1&2 + 3&4 · 4 1&2&3 · 8 1&2&3&4.
**Anti-passback**: 0 disabilitato · 1 (1:2);(3:4) · 2 (1,3):(2,4) · 3 1:(2,3) · 4 1:(2,3,4).
**Tipi di task** (`0xA8` byte 26): 0 porta controllata · 1 NA · 2 NC · 3 disabilita profilo orario · 4 abilita profilo · 5 solo tessera · 6 tessera + PIN in ingresso · 7 tessera + PIN · 8 abilita more cards · 9 disabilita more cards · 10 trigger singolo · 11 disabilita pulsante · 12 abilita pulsante.

### 5.8 Semantiche importanti

- **Eventi** — buffer circolare con indice **monotono crescente**; quando è pieno la scheda scarta ~2048 eventi vecchi; leggere un indice sovrascritto restituisce tipo 255; un indice oltre l'ultimo restituisce indice 0. L'"event index" (`0xB4`/`0xB2`) è solo un **segnalibro** memorizzato nella scheda (quello usato dal "Download" del software legacy), non cancella nulla. La nostra app memorizza il proprio `last_collected_index` nel DB e usa il segnalibro della scheda solo come informazione.
- **Ricezione eventi = push + pull** — il push UDP può perdersi (UDP, NAS spento, rete): il collector a indici recupera sempre i buchi (all'avvio, alla riconnessione, periodicamente e quando un push rivela un salto di indice).
- **Eventi porta/pulsante** (motivi 20, 23, 24…) vengono registrati solo con `0x8E` = abilitato.
- **Tessere** — la scheda non ha "aggiorna": `0x50` inserisce o sostituisce. La lettura completa richiede `0x58` (conteggio) e `0x5C` per indice fino a trovare tutte le tessere valide, saltando i tombstone `0xFFFFFFFF` (la scansione può superare il conteggio). Con 20.000 tessere ≈ 20.000 richieste → la sincronizzazione è **incrementale** (diff dal DB) e la lettura completa è un'operazione di verifica esplicita.
- **Permessi** — per ogni porta: 0 nessuno, 1 sempre, 2–254 = ID del profilo orario (che deve esistere sulla scheda).
- **Ora** — la scheda non ha NTP: l'app sincronizza l'ora periodicamente (e al ritorno online), registrando la deriva.
- **Set IP** — non dà risposta; nel peggiore dei casi la scheda finisce su una subnet irraggiungibile → l'interfaccia chiede conferma e verifica con discovery.
- **Restore defaults** (`0xC8`) — non verificato su hardware da uhppoted: azzera rete, listener, eventi, tessere. Solo per admin con doppia conferma.
- **PIN > 999999** — la scheda non lo rifiuta ma lo memorizza troncato → validazione lato app.
- **Ritardo porta** — campo u8: 0–255 s (il venditore dichiara fino a 600 s, non rappresentabile).

---

## 6. Strumenti dell'ecosistema uhppoted

| Strumento | Ruolo nel progetto |
|---|---|
| `uhppoted-codegen` → `models.json`, `test-data.json` | Specifica e **35 vettori ufficiali** request/response: golden test del nostro codec |
| npm `uhppoted` 0.9.1 | **devDependency**: test differenziali (stessa richiesta codificata dal nostro codec e dalla libreria → byte identici) |
| `uhppoted-simulator` (Docker `uhppoted/simulator`, REST :8000) | Emula UT0311-L04 (crea device, simula swipe con porta/direzione/PIN, apertura/chiusura porta, pulsante; listener + auto-send; TCP). Base dei test di integrazione e E2E. Nota: v0.9.1 senza build Windows (v0.9.0 sì) → in dev si usa Docker |
| `uhppoted-cli` (zip Windows) | Diagnosi indipendente sul campo: `get-devices`, `get-status`, `listen`… con `--debug` stampa i pacchetti → controprova sui test hardware |
| `uhppoted-rest` / `-mqtt` / `-httpd` | Alternative "pronte" (gateway Go). Scartate come backend: servizio in più da gestire, nessun push eventi via REST, modello dati non nostro. Restano utili come riferimento |

---

## 7. Valutazione libreria npm `uhppoted` e decisione

### 7.1 Pro
MIT, zero dipendenze, copre tutti i 34 comandi, supporta TCP, listener eventi, mantenuta (rilasci regolari 2021→2026).

### 7.2 Difetti verificati nel sorgente 0.9.1
1. **Unicast UDP ignorato per chiamata**: l'indirizzo passato come `{id, address}` viene usato **solo per TCP**; in UDP la destinazione deriva esclusivamente dalla mappa `config.controllers`, altrimenti si va in **broadcast** (`driver.js` → `udp(c, …)` non riceve `dest`).
2. **`config.bind` mai usato**: i socket fanno sempre `bind(0)` su tutte le interfacce → nessun controllo della NIC sui sistemi multi-interfaccia (tipico di un NAS con Docker).
3. **Bitmask relè errata**: `(byte & 0x02) === 1` è sempre falso → relè 2–4 decodificati sempre "chiusi" (`lookup.js`).
4. `isValidTaskType` numerico accetta 1–13 e l'encoder scrive `task − 1` (convenzione 1-based non documentata); il task 0 è raggiungibile solo per nome.
5. Le risposte passano da `JSON.stringify/parse` per l'internazionalizzazione: tutti i valori sono stringhe "umane" (`'{{normally open}}'`), nessun tipo TS.
6. Nessuna coda per controller: richieste concorrenti aprono socket concorrenti verso la stessa scheda (il firmware gestisce male il parallelismo).

### 7.3 Decisione
Implementiamo un pacchetto **`@uhppote-desk/protocol`** in TypeScript:
- `codec/` encoder/decoder tipizzati per i 34 comandi + evento (layout da `models.json`);
- `transport/` UDP (bind configurabile su IP di interfaccia, porta effimera con guardia anti-60000, broadcast di subnet) e TCP;
- `client/` API ad alto livello con **coda seriale per controller**, timeout, retry solo per letture idempotenti;
- `listener/` server UDP eventi con riconoscimento SOM `0x19`.
Qualità garantita da: vettori ufficiali (`test-data.json`), test differenziali contro `uhppoted`, simulatore, CLI ufficiale sul campo.
L'interfaccia `ControllerGateway` resta astratta: in caso di necessità si può ripiegare sulla libreria npm.

---

## 8. Rete e deploy

| Scenario | Indicazioni |
|---|---|
| **Docker sul NAS (produzione)** | `network_mode: host` (con bridge il broadcast non esce e gli eventi UDP non arrivano senza mappature fragili). Variabili: `UHPPOTE_BIND_ADDR` (IP della NIC verso la scheda), `UHPPOTE_BROADCAST` (es. `192.168.1.255:60000`), `UHPPOTE_LISTEN` (`0.0.0.0:60001`), `UHPPOTE_LISTENER_PUBLIC` (IP LAN del NAS che verrà scritto nella scheda), `UHPPOTE_TRANSPORT` (`udp`/`tcp`). Volume `/data` per SQLite e backup. |
| Sviluppo su Windows | `255.255.255.255` esce da una sola NIC (scelta dalla tabella di routing) → usare il broadcast di subnet e/o bind esplicito. Firewall: consentire **UDP in ingresso su 60001** per `node.exe`. Docker Desktop su Windows non supporta davvero `host` → il simulatore si raggiunge in unicast su `127.0.0.1:60000` e gli eventi verso `host.docker.internal`. |
| Scheda | IP statico nella stessa subnet del NAS; il listener della scheda punta a `IP_NAS:60001`. Se in futuro la scheda fosse su un'altra subnet: niente broadcast, solo unicast (o TCP), e serve una regola di routing per il push eventi. |
| Sicurezza | Il protocollo **non ha autenticazione né cifratura**: chiunque in LAN può aprire le porte. Consigliata VLAN dedicata per la scheda; l'app web solo in LAN/VPN, HTTPS tramite reverse proxy del NAS. |

---

## 9. Architettura proposta

```
┌──────────── Browser (React + Vite + Mantine) ────────────┐
│  REST (TanStack Query)            WebSocket (monitor live)│
└───────────────┬───────────────────────────┬──────────────┘
                │                           │
┌───────────────▼───────────────────────────▼──────────────┐
│ apps/server (Fastify, TypeScript)                        │
│  auth (sessioni, ruoli, audit) · API REST · WS hub       │
│  services: CardSync · ConfigSync · EventCollector ·      │
│            Health/TimeSync · Attendance · Backup         │
│  db: SQLite (better-sqlite3 + Drizzle, migrazioni)       │
│  ControllerGateway ─► @uhppote-desk/protocol             │
│                        client · codec · udp/tcp · listener│
└───────────────┬───────────────────────────▲──────────────┘
      UDP/TCP 60000 (comandi)        UDP 60001 (eventi push)
                ▼                           │
          ┌─────────────── UT0311-L04 ──────┴─┐
          └───────────────────────────────────┘
```

**Monorepo (npm workspaces)**: `packages/protocol`, `packages/shared` (schemi zod, DTO, enum e traduzioni IT dei codici), `apps/server`, `apps/web`, `tools/hwtest` (suite test hardware), `docker/`.

**Modello dati** (SQLite): controllers, doors, zones, departments, people, cards, permissions, time_profiles, tasks, controller_settings, events (unique controller+indice), attendance_rules / holidays / leaves / manual_punches, operators, audit_log, sync_runs.

**Principi**: il DB è la fonte di verità per persone/tessere/permessi; la scheda è un target sincronizzato con anteprima delle differenze. Ogni comando verso la scheda passa dal gateway e finisce nell'audit log con operatore, esito e durata.

---

## 10. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Firmware della scheda con differenze non documentate | Suite hardware L1 legge la versione; tutti i decoder tolleranti; confronto con `uhppoted-cli --debug` |
| Perdita di eventi UDP | Collector a indici con recupero buchi; push solo come "notifica rapida" |
| Discovery fallisce (NIC sbagliata, firewall, Docker bridge) | Bind e broadcast configurabili; host network; test L0 dedicati; fallback a IP diretto |
| Due gestionali sulla stessa scheda (listener unico, sync contrastanti) | Avviso in UI se il listener letto non punta al nostro host; documentazione |
| Comandi distruttivi (delete all, restore, set IP) | Solo admin, doppia conferma, backup tessere automatico prima dell'esecuzione |
| Tessere con numero stampato ≠ Wiegand-26 | Enrollment tramite swipe, validazione facility ≤ 255 / numero ≤ 65535 |
| Sicurezza LAN | VLAN, reverse proxy HTTPS, ruoli, audit |

---

## 11. Piano di test

### A. Unit (Vitest, nessuna rete)
- Codifiche: BCD date/datetime/HHmm/shortdate, IPv4, MAC, versione, uint24 PIN, magic.
- **Golden test**: tutti i 35 vettori di `test-data.json` (encode request = bytes attesi; decode response = valori attesi).
- **Test differenziali** contro npm `uhppoted` per input casuali validi (property-based con fast-check).
- Wiegand-26 ↔ facility/numero; validazioni (PIN, porta 1–4, profilo 2–254).
- Logica: diff CardSync (aggiunte, modifiche, rimozioni, tombstone), EventCollector (buchi, tipo 255, ripartenza), motore presenze (turni notturni, festività, ferie, timbrature dispari).

### B. Integrazione con simulatore (`docker-compose.test.yml`)
Crea un UT0311-L04 via REST → per ogni metodo del client: chiamata + rilettura (ora, door control, listener, profili, task, interblocco, APB, tessere, apertura porta). Swipe simulato → evento push → riga DB → messaggio WebSocket. Listener disattivato → swipe → recupero da collector. Simulatore fermo → timeout ed errori gestiti.

### C. E2E (Playwright, contro simulatore)
Login per ruolo (sola lettura non può aprire porte), CRUD persona + tessera → sincronizzazione → tessera presente sul simulatore; monitor live riceve lo swipe; report presenze.

### D. Suite test hardware (`npm run hw -- --level N`, vedi README per la procedura)
Guidata e interattiva dove serve un'azione fisica; **non distruttiva di default** (backup tessere/config prima delle scritture, `--destructive` per reset/delete-all); report Markdown + JSON in `reports/`.

| Livello | Verifiche |
|---|---|
| **L0 Rete** | interfacce dell'host, ping IP scheda, discovery broadcast (subnet e globale), porta 60001 libera, ricezione UDP in ingresso (firewall), connessione TCP 60000 |
| **L1 Sola lettura** | get controller (S/N, IP, MAC, **firmware**, data), ora + deriva, status, listener, door control ×4, conteggio tessere, event index, primo/ultimo evento, anti-passback; confronto con `uhppoted-cli` |
| **L2 Scritture sicure** | set time + verifica, set listener verso l'host + auto-send ricevuto, put/get/delete tessera di test, profilo orario 254 set/get, ritardo porta modifica + ripristino, record special events |
| **L3 Fisico** (prompt) | apertura remota porte 1–4 (scatto relè), swipe tessera autorizzata/non autorizzata → evento con motivo corretto, sensore porta, pulsante uscita, PIN da tastiera, accesso fuori fascia → motivo 13 |
| **L4 Robustezza** | cavo scollegato → offline → riconnessione → recupero eventi; riavvio scheda (motivo 28); caricamento 1.000 tessere (tempi); 100 richieste consecutive; raffica di eventi |
| **L5 Deploy** | L0–L2 eseguiti dal container sul NAS (host network) e verifica che la scheda raggiunga il listener |

---

### E. Comportamenti osservati sul simulatore ufficiale uhppoted (v0.9.0)

Eseguendo client e suite hardware contro il simulatore Go (implementazione indipendente dalla nostra) sono emersi dettagli di cui l'app e i test tengono conto; vanno **riconfermati sulla scheda reale** (L2/L3):

| Osservazione | Conseguenza |
|---|---|
| L'**auto-invio** periodico al listener parte solo se esiste almeno un evento memorizzato | Il test L2.2 segnala un avviso (non un errore) se la scheda è vuota; la verifica di ricezione è ripetuta in L3 |
| Una tessera non registrata è negata con motivo **18** ("accesso negato") e non 6 | L3.6 accetta 6 o 18 e registra il valore effettivo nel report |
| `set-event-index` con indice oltre l'ultimo evento risponde `ok = false` | L2.7 usa un indice esistente |
| `set-first-card` (0xAA) **non supportato**: il simulatore va in panic | Comando coperto dai vettori ufficiali e dal FakeController; da verificare sulla scheda |
| Il controller dichiara il proprio IP (anche diverso da quello da cui risponde) | L0.5 segnala la discrepanza (utile per individuare NAT) |

---

## 12. Stato dell'implementazione

Implementato secondo l'architettura del §9, con una variazione rispetto al piano: invece di usare la libreria npm `uhppoted` dietro un adapter, il codec e il trasporto sono propri (§7.3) e la libreria è usata solo come riferimento nei test differenziali.

| Area | Stato | Verifica automatica |
|---|---|---|
| Protocollo (34 comandi, UDP/TCP, listener, SOM 0x19) | ✅ | 70 golden test sui vettori ufficiali, test differenziali (≈ 2.000 casi casuali), integrazione con FakeController e con il simulatore uhppoted |
| Controller: ricerca, IP, ora, listener, diagnostica, ripristino | ✅ | integrazione server + E2E |
| Persone, tessere (smarrimento, acquisizione da lettore, import CSV), permessi, sincronizzazione con anteprima | ✅ | integrazione server + E2E |
| Eventi: push + raccolta per indice, recupero buchi, epoche dopo reset, monitor WebSocket, storico, export | ✅ | integrazione server + E2E |
| Fasce orarie, task, porte, interblocco, anti-passback, tastiere, codici porta, first card, eventi speciali, PC control | ✅ | integrazione server |
| Presenze: turni (anche notturni), festività (con Pasqua), ferie/assenze, timbrature manuali, report + CSV | ✅ | unit |
| Operatori con ruoli e zone, audit log, backup giornaliero | ✅ | integrazione server + E2E |
| Suite di collaudo hardware L0-L5 | ✅ | eseguita contro FakeController (tutti i livelli) e contro il simulatore uhppoted (L0-L2) |
| Immagine Docker / compose per NAS | ✅ (da provare sul NAS) | — (Docker non disponibile sul PC di sviluppo) |

Non incluso nella v1 (vedi §4): mensa, ronda, riunioni, ascensori, configurazione delle uscite di allarme, definizione dei gruppi multi-tessera, migrazione dal database legacy.

---

## 13. Domande aperte (da chiarire all'arrivo della scheda)

1. Versione firmware effettiva (determina SOM `0x19`, supporto TCP, eventuali bug noti).
2. Lettori installati: solo Wiegand-26? Con tastiera (per PIN / card + PIN)?
3. Sensori porta e pulsanti uscita cablati su tutte e 4 le porte?
4. Indirizzamento: subnet del NAS e IP statico da assegnare alla scheda.
5. Eventuale migrazione dati dal software legacy (`iCCard3000.mdb`, pwd `168168`) — fuori scope v1, fattibile come import.
