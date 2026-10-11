/** Fixed size of every packet (request, response, event). */
export const PACKET_SIZE = 64

/** Start-of-message standard. */
export const SOM = 0x17

/** Start-of-message used by firmware v6.62 for listener events (only with function code 0x20). */
export const SOM_V662_EVENT = 0x19

/** Magic word required by destructive/configuration commands. */
export const MAGIC = 0x55aaaa55

/** UDP/TCP port of the controller. */
export const CONTROLLER_PORT = 60000

/** Conventional host port for receiving events. */
export const DEFAULT_LISTENER_PORT = 60001

export const FunctionCode = {
  GetStatus: 0x20,
  SetTime: 0x30,
  GetTime: 0x32,
  OpenDoor: 0x40,
  PutCard: 0x50,
  DeleteCard: 0x52,
  DeleteAllCards: 0x54,
  GetCards: 0x58,
  GetCard: 0x5a,
  GetCardAtIndex: 0x5c,
  SetDoorControl: 0x80,
  GetDoorControl: 0x82,
  SetAntiPassback: 0x84,
  GetAntiPassback: 0x86,
  SetTimeProfile: 0x88,
  ClearTimeProfiles: 0x8a,
  SetDoorPasscodes: 0x8c,
  RecordSpecialEvents: 0x8e,
  SetListener: 0x90,
  GetListener: 0x92,
  GetController: 0x94,
  SetIPv4: 0x96,
  GetTimeProfile: 0x98,
  SetPCControl: 0xa0,
  SetInterlock: 0xa2,
  ActivateKeypads: 0xa4,
  ClearTaskList: 0xa6,
  AddTask: 0xa8,
  SetFirstCard: 0xaa,
  RefreshTaskList: 0xac,
  GetEvent: 0xb0,
  SetEventIndex: 0xb2,
  GetEventIndex: 0xb4,
  RestoreDefaultParameters: 0xc8,
} as const

export type FunctionCode = (typeof FunctionCode)[keyof typeof FunctionCode]

/** Door mode for 0x80/0x82. */
export const DoorMode = {
  NormallyOpen: 1,
  NormallyClosed: 2,
  Controlled: 3,
} as const
export type DoorMode = (typeof DoorMode)[keyof typeof DoorMode]

/** First-card mode for 0xAA (encoded differently from DoorMode!). */
export const FirstCardMode = {
  Controlled: 0,
  NormallyOpen: 1,
  NormallyClosed: 2,
  FirstCardOnly: 3,
} as const
export type FirstCardMode = (typeof FirstCardMode)[keyof typeof FirstCardMode]

export const Interlock = {
  None: 0,
  Doors12: 1,
  Doors34: 2,
  Doors12And34: 3,
  Doors123: 4,
  Doors1234: 8,
} as const
export type Interlock = (typeof Interlock)[keyof typeof Interlock]
export const INTERLOCK_VALUES: readonly number[] = Object.values(Interlock)

export const AntiPassback = {
  Disabled: 0,
  Doors12_34: 1,
  Doors13_24: 2,
  Door1_23: 3,
  Door1_234: 4,
} as const
export type AntiPassback = (typeof AntiPassback)[keyof typeof AntiPassback]

export const TaskType = {
  DoorControlled: 0,
  DoorNormallyOpen: 1,
  DoorNormallyClosed: 2,
  DisableTimeProfile: 3,
  EnableTimeProfile: 4,
  CardNoPassword: 5,
  CardInPassword: 6,
  CardPassword: 7,
  EnableMoreCards: 8,
  DisableMoreCards: 9,
  TriggerOnce: 10,
  DisablePushButton: 11,
  EnablePushButton: 12,
} as const
export type TaskType = (typeof TaskType)[keyof typeof TaskType]

export const EventType = {
  None: 0,
  Swipe: 1,
  Door: 2,
  Alarm: 3,
  Overwritten: 0xff,
} as const

export const Direction = {
  In: 1,
  Out: 2,
} as const

/** Known reason codes (byte 27 of events/status). */
export const Reason = {
  Swipe: 1,
  SwipeOpen: 2,
  SwipeClose: 3,
  DeniedSystem: 5,
  NoAccessRights: 6,
  IncorrectPassword: 7,
  AntiPassback: 8,
  MoreCards: 9,
  FirstCardOpen: 10,
  DoorNormallyClosed: 11,
  Interlock: 12,
  NotInAllowedTimePeriod: 13,
  InvalidTimezone: 15,
  AccessDenied: 18,
  PushButtonOk: 20,
  DoorOpened: 23,
  DoorClosed: 24,
  SupervisorDoorOpen: 25,
  ControllerPowerOn: 28,
  ControllerReset: 29,
  PushButtonDoorLocked: 31,
  PushButtonOffline: 32,
  PushButtonInterlock: 33,
  PushButtonThreat: 34,
  DoorOpenTooLong: 37,
  ForcedOpen: 38,
  Fire: 39,
  ForcedClosed: 40,
  TheftPrevention: 41,
  Zone24x7: 42,
  Emergency: 43,
  RemoteOpenDoor: 44,
  RemoteOpenDoorUsb: 45,
} as const
