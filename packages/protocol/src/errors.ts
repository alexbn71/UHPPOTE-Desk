/** Base class of all protocol errors. */
export class UhppoteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Value that cannot be encoded or packet that cannot be decoded. */
export class CodecError extends UhppoteError {}

/** No reply within the timeout. */
export class TimeoutError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly functionCode: number,
    readonly timeoutMs: number,
  ) {
    super(
      `no reply from controller ${controller} (function 0x${functionCode.toString(16).padStart(2, '0')}) within ${timeoutMs} ms`,
    )
  }
}

/** The controller replied but refused/did not perform the operation (ok = false). */
export class OperationFailedError extends UhppoteError {
  constructor(
    readonly controller: number,
    readonly operation: string,
  ) {
    super(`controller ${controller} did not perform the operation '${operation}'`)
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
    super(`event ${index} of controller ${controller} has been overwritten`)
  }
}

/** Network error (bind, send, TCP connection). */
export class TransportError extends UhppoteError {}
