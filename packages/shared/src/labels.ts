/** Etichette italiane per i codici del protocollo (condivise da server, web e report). */

export const REASON_LABELS: Record<number, string> = {
  1: 'Tessera',
  2: 'Tessera (apertura)',
  3: 'Tessera (chiusura)',
  5: 'Negato (gestito dal PC)',
  6: 'Nessun diritto di accesso',
  7: 'Password errata',
  8: 'Anti-passback',
  9: 'Multi-tessera',
  10: 'First card',
  11: 'Porta normalmente chiusa',
  12: 'Interblocco',
  13: 'Fuori fascia oraria',
  15: 'Fuso orario non valido',
  18: 'Accesso negato',
  20: 'Pulsante uscita',
  23: 'Porta aperta',
  24: 'Porta chiusa',
  25: 'Porta aperta (password supervisore)',
  28: 'Accensione controller',
  29: 'Reset controller',
  31: 'Pulsante non valido (porta bloccata)',
  32: 'Pulsante non valido (offline)',
  33: 'Pulsante non valido (interblocco)',
  34: 'Pulsante non valido (minaccia)',
  37: 'Porta aperta troppo a lungo',
  38: 'Apertura forzata',
  39: 'Incendio',
  40: 'Chiusura forzata',
  41: 'Antifurto',
  42: 'Zona 24×7',
  43: 'Emergenza',
  44: 'Apertura remota',
  45: 'Apertura remota (lettore USB)',
}

export function reasonLabel(code: number): string {
  return REASON_LABELS[code] ?? `Motivo ${code}`
}

export const EVENT_TYPE_LABELS: Record<number, string> = {
  0: 'Nessuno',
  1: 'Tessera',
  2: 'Porta',
  3: 'Allarme',
  255: 'Sovrascritto',
}

export const DIRECTION_LABELS: Record<number, string> = { 1: 'Ingresso', 2: 'Uscita' }

export const DOOR_MODE_LABELS: Record<number, string> = {
  1: 'Normalmente aperta',
  2: 'Normalmente chiusa',
  3: 'Controllata',
}

export const FIRST_CARD_MODE_LABELS: Record<number, string> = {
  0: 'Controllata',
  1: 'Normalmente aperta',
  2: 'Normalmente chiusa',
  3: 'Solo first card',
}

export const INTERLOCK_LABELS: Record<number, string> = {
  0: 'Disattivato',
  1: 'Porte 1 e 2',
  2: 'Porte 3 e 4',
  3: 'Porte 1-2 e 3-4',
  4: 'Porte 1, 2 e 3',
  8: 'Porte 1, 2, 3 e 4',
}

export const ANTIPASSBACK_LABELS: Record<number, string> = {
  0: 'Disattivato',
  1: '(1:2);(3:4)',
  2: '(1,3):(2,4)',
  3: '1:(2,3)',
  4: '1:(2,3,4)',
}

export const TASK_LABELS: Record<number, string> = {
  0: 'Porta controllata',
  1: 'Porta normalmente aperta',
  2: 'Porta normalmente chiusa',
  3: 'Disabilita fasce orarie',
  4: 'Abilita fasce orarie',
  5: 'Solo tessera (senza PIN)',
  6: 'Tessera + PIN in ingresso',
  7: 'Tessera + PIN',
  8: 'Abilita multi-tessera',
  9: 'Disabilita multi-tessera',
  10: 'Apertura singola',
  11: 'Disabilita pulsante',
  12: 'Abilita pulsante',
}

export const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'] as const

export const ROLE_LABELS = {
  admin: 'Amministratore',
  operator: 'Operatore',
  viewer: 'Sola lettura',
} as const

export const LEAVE_TYPE_LABELS = {
  ferie: 'Ferie',
  permesso: 'Permesso',
  malattia: 'Malattia',
  trasferta: 'Trasferta',
  altro: 'Altro',
} as const

/** Motivi che indicano un allarme/anomalia da evidenziare nel monitor. */
export const ALARM_REASONS = new Set([34, 37, 38, 39, 40, 41, 42, 43])
