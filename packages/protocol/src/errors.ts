/** Errore base di tutti gli errori del protocollo. */
export class UhppoteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Valore non codificabile o pacchetto non decodificabile. */
export class CodecError extends UhppoteError {}

/** Nessuna risposta entro il timeout. */
export class TimeoutError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly functionCode: number,
    readonly timeoutMs: number,
  ) {
    super(
      `nessuna risposta dal controller ${controller} (funzione 0x${functionCode.toString(16).padStart(2, '0')}) entro ${timeoutMs} ms`,
    )
  }
}

/** Il controller ha risposto ma ha rifiutato/non eseguito l'operazione (ok = false). */
export class OperationFailedError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly operation: string,
  ) {
    super(`il controller ${controller} non ha eseguito l'operazione '${operation}'`)
  }
}

/** Elemento richiesto non presente sul controller (tessera, profilo, evento). */
export class NotFoundError extends UhppoteError {}

/** Evento sovrascritto nel buffer circolare del controller. */
export class EventOverwrittenError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly index: number,
  ) {
    super(`evento ${index} del controller ${controller} sovrascritto`)
  }
}

/** Errore di rete (bind, invio, connessione TCP). */
export class TransportError extends UhppoteError {}
