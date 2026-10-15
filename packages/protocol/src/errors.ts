type Params = Record<string, string | number>

/** Options of a protocol error: `code` and `params` identify a translatable message (`errors.<code>`). */
export interface UhppoteErrorOptions extends ErrorOptions {
  code?: string
  params?: Params
}

/** Base class of all protocol errors. */
export class UhppoteError extends Error {
  /** Translation key below `errors.` describing the error to the user. */
  readonly code: string
  /** Values of the placeholders of the translated message. */
  readonly params: Params

  constructor(message: string, options: UhppoteErrorOptions = {}) {
    const { code, params, ...rest } = options
    super(message, rest)
    this.name = new.target.name
    this.code = code ?? 'protocol.generic'
    this.params = params ?? { detail: message }
  }
}

/** Value that cannot be encoded or packet that cannot be decoded. */
export class CodecError extends UhppoteError {
  constructor(message: string, options: UhppoteErrorOptions = {}) {
    super(message, { code: 'protocol.invalidValue', ...options })
  }
}

/** No reply within the timeout. */
export class TimeoutError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly functionCode: number,
    readonly timeoutMs: number,
  ) {
    const fn = `0x${functionCode.toString(16).padStart(2, '0')}`
    super(`no reply from controller ${controller} (function ${fn}) within ${timeoutMs} ms`, {
      code: 'protocol.timeout',
      params: { controller, function: fn, timeoutMs },
    })
  }
}

/** The controller replied but refused/did not perform the operation (ok = false). */
export class OperationFailedError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly operation: string,
  ) {
    super(`controller ${controller} did not perform the operation '${operation}'`, {
      code: 'protocol.refused',
      params: { controller, operation },
    })
  }
}

/** Requested item not present on the controller (card, profile, event). */
export class NotFoundError extends UhppoteError {}

/** Event overwritten in the controller's ring buffer. */
export class EventOverwrittenError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly index: number,
  ) {
    super(`event ${index} of controller ${controller} has been overwritten`, {
      code: 'protocol.eventOverwritten',
      params: { controller, index },
    })
  }
}

/** Network error (bind, send, TCP connection). */
export class TransportError extends UhppoteError {}
