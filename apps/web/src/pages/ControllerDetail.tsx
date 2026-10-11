import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Grid,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconAlertTriangle, IconClock, IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { ControllerDto, ControllerSettings } from '@uhppote-desk/shared'
import { ANTIPASSBACK_LABELS, DOOR_MODE_LABELS, FIRST_CARD_MODE_LABELS, INTERLOCK_LABELS, reasonLabel } from '@uhppote-desk/shared'
import { PageHeader, WeekdaysInput } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate, fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { ControllerFormFields, controllerBody, type ControllerForm } from './Controllers'

interface Info {
  device: { controller: number; address: string; netmask: string; gateway: string; mac: string; version: string; date: string | null }
  time: string | null
  status: {
    doorOpen: boolean[]
    buttonPressed: boolean[]
    relayUnlocked: boolean[]
    forceLock: boolean
    fireAlarm: boolean
    systemError: number
    specialInfo: number
    event: { index: number; card: number; door: number; granted: boolean; reason: number; timestamp: string | null } | null
  }
  listener: { address: string; port: number; interval: number }
  cards: number
  eventIndex: number
  antipassback: number
  doors: { door: number; mode: number; delay: number }[]
}

function Diagnostics({ id }: { id: number }) {
  const info = useQuery({ queryKey: ['controller-info', id], queryFn: () => api.get<Info>(`/controllers/${id}/info`), retry: false })
  const { can } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)

  const action = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name)
    try {
      await fn()
      notifyOk(ok)
      void info.refetch()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(null)
    }
  }

  if (info.isError) {
    return (
      <Alert color="red" icon={<IconAlertTriangle />} title="Controller non raggiungibile">
        {(info.error as Error).message}
        <Button mt="sm" size="xs" variant="light" onClick={() => void info.refetch()}>
          Riprova
        </Button>
      </Alert>
    )
  }
  const d = info.data
  return (
    <Stack>
      <Group>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={info.isFetching} onClick={() => void info.refetch()}>
          Rileggi dal controller
        </Button>
        {can('operator') && (
          <>
            <Button variant="default" leftSection={<IconClock size={16} />} loading={busy === 'time'} onClick={() => void action('time', () => api.post(`/controllers/${id}/time-sync`), 'Ora sincronizzata')}>
              Sincronizza ora
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              loading={busy === 'collect'}
              onClick={() =>
                void action(
                  'collect',
                  async () => {
                    const r = await api.post<{ collected: number; skipped: number }>(`/controllers/${id}/collect`)
                    notifyOk(`Eventi scaricati: ${r.collected}${r.skipped ? ` (sovrascritti: ${r.skipped})` : ''}`)
                  },
                  'Raccolta eventi completata',
                )
              }
            >
              Scarica eventi
            </Button>
          </>
        )}
      </Group>
      {d && (
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder>
              <Title order={5} mb="xs">
                Dispositivo
              </Title>
              <Table>
                <Table.Tbody>
                  {[
                    ['Numero di serie', d.device.controller],
                    ['Indirizzo IP', `${d.device.address} / ${d.device.netmask}`],
                    ['Gateway', d.device.gateway],
                    ['MAC', d.device.mac],
                    ['Firmware', `${d.device.version} del ${fmtDate(d.device.date)}`],
                    ['Ora del controller', fmtDateTime(d.time)],
                    ['Tessere memorizzate', d.cards],
                    ['Ultimo evento', d.status.event ? `#${d.status.event.index} — ${reasonLabel(d.status.event.reason)} (${fmtDateTime(d.status.event.timestamp)})` : 'nessuno'],
                    ['Segnalibro download', d.eventIndex],
                    ['Listener eventi', `${d.listener.address}:${d.listener.port}${d.listener.interval ? ` (auto-invio ogni ${d.listener.interval}s)` : ''}`],
                    ['Anti-passback', ANTIPASSBACK_LABELS[d.antipassback] ?? d.antipassback],
                    ['Errore di sistema', d.status.systemError],
                  ].map(([k, v]) => (
                    <Table.Tr key={String(k)}>
                      <Table.Td c="dimmed" w={200}>
                        {k}
                      </Table.Td>
                      <Table.Td className="mono">{String(v)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Card withBorder>
              <Title order={5} mb="xs">
                Porte (stato letto dal controller)
              </Title>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Porta</Table.Th>
                    <Table.Th>Modalità</Table.Th>
                    <Table.Th>Ritardo</Table.Th>
                    <Table.Th>Sensore</Table.Th>
                    <Table.Th>Relè</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.doors.map((door, i) => (
                    <Table.Tr key={door.door}>
                      <Table.Td>{door.door}</Table.Td>
                      <Table.Td>{DOOR_MODE_LABELS[door.mode] ?? door.mode}</Table.Td>
                      <Table.Td>{door.delay}s</Table.Td>
                      <Table.Td>
                        <Badge color={d.status.doorOpen[i] ? 'orange' : 'teal'} variant="light">
                          {d.status.doorOpen[i] ? 'Aperta' : 'Chiusa'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{d.status.relayUnlocked[i] ? 'Sbloccato' : 'Bloccato'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {(d.status.fireAlarm || d.status.forceLock) && (
                <Alert color="red" mt="sm">
                  {d.status.fireAlarm && 'Ingresso allarme incendio attivo. '}
                  {d.status.forceLock && 'Ingresso blocco forzato attivo.'}
                </Alert>
              )}
            </Card>
          </Grid.Col>
        </Grid>
      )}
    </Stack>
  )
}

function Network({ c }: { c: ControllerDto }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [form, setForm] = useState<ControllerForm>({ ...c, serial: c.serial, host: c.host ?? '', zoneId: c.zoneId ? String(c.zoneId) : null })
  const [ip, setIp] = useState({ address: c.host ?? '', netmask: '255.255.255.0', gateway: '' })
  const [listener, setListener] = useState({ address: '', port: 60001, interval: 0 })

  const save = async () => {
    try {
      await api.put(`/controllers/${c.id}`, controllerBody(form))
      notifyOk('Controller aggiornato')
      void qc.invalidateQueries({ queryKey: ['controllers'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const setIpAddress = () =>
    modals.openConfirmModal({
      title: 'Cambio indirizzo IP del controller',
      children: (
        <Text size="sm">
          Il controller verrà riconfigurato con IP {ip.address}/{ip.netmask}, gateway {ip.gateway}. Se l'indirizzo non è raggiungibile da questo server la scheda
          non sarà più contattabile finché non verrà riconfigurata (dalla stessa rete, via broadcast). Continuare?
        </Text>
      ),
      labels: { confirm: 'Cambia IP', cancel: 'Annulla' },
      confirmProps: { color: 'orange' },
      onConfirm: () =>
        api
          .post<{ verified: boolean }>(`/controllers/${c.id}/set-ip`, ip)
          .then((r) => {
            if (r.verified) notifyOk('IP impostato e verificato')
            else notifyError(new Error('Comando inviato ma il controller non risponde sul nuovo IP: verificare con la ricerca in rete'))
            void qc.invalidateQueries({ queryKey: ['controllers'] })
          })
          .catch(notifyError),
    })

  const remove = () =>
    modals.openConfirmModal({
      title: 'Rimuovi controller',
      children: <Text size="sm">Il controller e il suo storico eventi verranno rimossi dal database (la scheda non viene modificata).</Text>,
      labels: { confirm: 'Rimuovi', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/controllers/${c.id}`)
          .then(() => {
            void qc.invalidateQueries({ queryKey: ['controllers'] })
            navigate('/controller')
          })
          .catch(notifyError),
    })

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }}>
      <Card withBorder>
        <Title order={5} mb="sm">
          Configurazione nell'applicazione
        </Title>
        <Stack>
          <ControllerFormFields form={form} setForm={setForm} />
          <Group>
            <Button onClick={() => void save()}>Salva</Button>
            <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={remove}>
              Rimuovi
            </Button>
          </Group>
        </Stack>
      </Card>
      <Stack>
        <Card withBorder>
          <Title order={5} mb="sm">
            Indirizzo IP della scheda
          </Title>
          <Stack>
            <SimpleGrid cols={3}>
              <TextInput label="IP" value={ip.address} onChange={(e) => setIp({ ...ip, address: e.currentTarget.value })} />
              <TextInput label="Netmask" value={ip.netmask} onChange={(e) => setIp({ ...ip, netmask: e.currentTarget.value })} />
              <TextInput label="Gateway" value={ip.gateway} onChange={(e) => setIp({ ...ip, gateway: e.currentTarget.value })} />
            </SimpleGrid>
            <Button variant="light" color="orange" onClick={setIpAddress} disabled={!ip.address || !ip.netmask || !ip.gateway}>
              Invia nuovo IP alla scheda
            </Button>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            Destinazione eventi (listener)
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            La scheda invia ogni evento a un solo indirizzo. Normalmente viene configurato in automatico (variabile UHPPOTE_LISTENER_PUBLIC).
          </Text>
          <Group>
            <Button
              variant="light"
              onClick={() =>
                api
                  .post<{ changed: boolean }>(`/controllers/${c.id}/listener`, null)
                  .then((r) => notifyOk(r.changed ? 'Listener aggiornato' : 'Listener già corretto'))
                  .catch(notifyError)
              }
            >
              Configura automaticamente
            </Button>
          </Group>
          <SimpleGrid cols={3} mt="sm">
            <TextInput label="IP" value={listener.address} onChange={(e) => setListener({ ...listener, address: e.currentTarget.value })} />
            <NumberInput label="Porta" value={listener.port} onChange={(v) => setListener({ ...listener, port: Number(v) })} hideControls />
            <NumberInput label="Auto-invio (s)" value={listener.interval} min={0} max={255} onChange={(v) => setListener({ ...listener, interval: Number(v) })} />
          </SimpleGrid>
          <Button
            mt="sm"
            variant="default"
            disabled={!listener.address}
            onClick={() =>
              api
                .post(`/controllers/${c.id}/listener`, listener)
                .then(() => notifyOk('Listener impostato'))
                .catch(notifyError)
            }
          >
            Imposta manualmente
          </Button>
        </Card>
      </Stack>
    </SimpleGrid>
  )
}

function AdvancedSettings({ id }: { id: number }) {
  const { can } = useAuth()
  const settings = useQuery({ queryKey: ['settings', id], queryFn: () => api.get<ControllerSettings>(`/controllers/${id}/settings`) })
  const [s, setS] = useState<ControllerSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const readOnly = !can('admin')
  useEffect(() => {
    if (settings.data) setS(settings.data)
  }, [settings.data])
  if (!s) return null

  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/controllers/${id}/settings`, s)
      notifyOk('Impostazioni salvate e inviate al controller')
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const fcDefault = { enabled: true, start: '08:00', end: '18:00', activeMode: 0, inactiveMode: 3, weekdays: [true, true, true, true, true, false, false] }

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Title order={5} mb="sm">
            Regole di passaggio
          </Title>
          <Stack>
            <Select
              label="Interblocco"
              description="Le porte del gruppo non possono essere aperte contemporaneamente"
              data={Object.entries(INTERLOCK_LABELS).map(([v, l]) => ({ value: v, label: l }))}
              value={String(s.interlock)}
              onChange={(v) => setS({ ...s, interlock: Number(v) as ControllerSettings['interlock'] })}
              readOnly={readOnly}
            />
            <Select
              label="Anti-passback"
              description="Impedisce di rientrare senza essere usciti (gruppi di lettori)"
              data={Object.entries(ANTIPASSBACK_LABELS).map(([v, l]) => ({ value: v, label: l }))}
              value={String(s.antipassback)}
              onChange={(v) => setS({ ...s, antipassback: Number(v) })}
              readOnly={readOnly}
            />
            <Switch
              label="Registra eventi porta e pulsante (apertura/chiusura, pulsante uscita)"
              checked={s.recordSpecialEvents}
              onChange={(e) => setS({ ...s, recordSpecialEvents: e.currentTarget.checked })}
              disabled={readOnly}
            />
            <Switch
              label="Controllo da PC (la scheda delega le decisioni al server; sconsigliato)"
              checked={s.pcControl}
              onChange={(e) => setS({ ...s, pcControl: e.currentTarget.checked })}
              disabled={readOnly}
            />
            <NumberInput
              label="Auto-invio stato al listener (secondi, 0 = solo eventi)"
              min={0}
              max={255}
              value={s.listenerInterval}
              onChange={(v) => setS({ ...s, listenerInterval: Number(v) || 0 })}
              readOnly={readOnly}
            />
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            Tastiere e codici porta
          </Title>
          <Stack>
            <Group>
              {[0, 1, 2, 3].map((i) => (
                <Checkbox
                  key={i}
                  label={`Tastiera lettore ${i + 1}`}
                  checked={s.keypads[i]}
                  disabled={readOnly}
                  onChange={(e) => {
                    const k = [...s.keypads]
                    k[i] = e.currentTarget.checked
                    setS({ ...s, keypads: k })
                  }}
                />
              ))}
            </Group>
            {[0, 1, 2, 3].map((i) => (
              <TagsInput
                key={i}
                label={`Codici porta ${i + 1} (max 4, fino a 6 cifre)`}
                maxTags={4}
                value={s.passcodes[i].map(String)}
                disabled={readOnly}
                onChange={(v) => {
                  const p = s.passcodes.map((x) => [...x])
                  p[i] = v.map((x) => Number(x.replace(/\D/g, ''))).filter((n) => n > 0 && n <= 999999)
                  setS({ ...s, passcodes: p })
                }}
              />
            ))}
          </Stack>
        </Card>
      </SimpleGrid>
      <Card withBorder>
        <Title order={5} mb="sm">
          First card (la porta si sblocca solo dopo il primo passaggio autorizzato)
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {[0, 1, 2, 3].map((i) => {
            const fc = s.firstCard[i]
            const setFc = (v: ControllerSettings['firstCard'][number]) => {
              const all = [...s.firstCard]
              all[i] = v
              setS({ ...s, firstCard: all })
            }
            return (
              <Card key={i} withBorder padding="sm">
                <Switch label={`Porta ${i + 1}`} checked={!!fc?.enabled} disabled={readOnly} onChange={(e) => setFc(e.currentTarget.checked ? { ...fcDefault, ...(fc ?? {}), enabled: true } : fc ? { ...fc, enabled: false } : null)} />
                {fc?.enabled && (
                  <Stack mt="xs" gap="xs">
                    <Group grow>
                      <TextInput label="Dalle" value={fc.start} onChange={(e) => setFc({ ...fc, start: e.currentTarget.value })} readOnly={readOnly} />
                      <TextInput label="Alle" value={fc.end} onChange={(e) => setFc({ ...fc, end: e.currentTarget.value })} readOnly={readOnly} />
                    </Group>
                    <Group grow>
                      <Select
                        label="Dopo la prima tessera"
                        data={[0, 1, 2].map((m) => ({ value: String(m), label: FIRST_CARD_MODE_LABELS[m]! }))}
                        value={String(fc.activeMode)}
                        onChange={(v) => setFc({ ...fc, activeMode: Number(v) })}
                        readOnly={readOnly}
                      />
                      <Select
                        label="Fuori orario"
                        data={[0, 1, 2, 3].map((m) => ({ value: String(m), label: FIRST_CARD_MODE_LABELS[m]! }))}
                        value={String(fc.inactiveMode)}
                        onChange={(v) => setFc({ ...fc, inactiveMode: Number(v) })}
                        readOnly={readOnly}
                      />
                    </Group>
                    <WeekdaysInput value={fc.weekdays} onChange={(w) => setFc({ ...fc, weekdays: w })} />
                  </Stack>
                )}
              </Card>
            )
          })}
        </SimpleGrid>
      </Card>
      {!readOnly && (
        <Button onClick={() => void save()} loading={busy}>
          Salva e invia al controller
        </Button>
      )}
    </Stack>
  )
}

function Maintenance({ c }: { c: ControllerDto }) {
  const [confirm, setConfirm] = useState('')
  const history = useQuery({
    queryKey: ['sync-history', c.id],
    queryFn: () => api.get<{ id: number; kind: string; startedAt: string; status: string; summary: string | null; operator: string | null }[]>(`/controllers/${c.id}/sync/history`),
  })
  return (
    <Stack>
      <Card withBorder>
        <Title order={5} mb="xs">
          Storico sincronizzazioni
        </Title>
        <Table>
          <Table.Tbody>
            {(history.data ?? []).map((h) => (
              <Table.Tr key={h.id}>
                <Table.Td>{fmtDateTime(h.startedAt)}</Table.Td>
                <Table.Td>{h.operator ?? 'sistema'}</Table.Td>
                <Table.Td>
                  <Badge color={h.status === 'ok' ? 'green' : h.status === 'error' ? 'red' : 'blue'}>{h.status}</Badge>
                </Table.Td>
                <Table.Td>
                  <Code>{h.summary}</Code>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Card withBorder style={{ borderColor: 'var(--mantine-color-red-6)' }}>
        <Title order={5} c="red" mb="xs">
          Ripristino parametri di fabbrica
        </Title>
        <Text size="sm" mb="sm">
          Azzera rete, listener, tessere ed eventi della scheda. Le tessere presenti vengono salvate prima dell'operazione e possono essere reinviate con una
          sincronizzazione. Digitare il numero di serie <b>{c.serial}</b> per confermare.
        </Text>
        <Group>
          <TextInput value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} placeholder="Numero di serie" />
          <Button
            color="red"
            disabled={confirm !== String(c.serial)}
            onClick={() =>
              api
                .post<{ cardsBackup: unknown[]; backupFile: string }>(`/controllers/${c.id}/restore-defaults`, { confirm })
                .then((r) => notifyOk(`Parametri ripristinati: ${r.cardsBackup.length} tessere salvate in ${r.backupFile} (cartella backup del server)`))
                .catch(notifyError)
            }
          >
            Ripristina
          </Button>
        </Group>
      </Card>
    </Stack>
  )
}

export function ControllerDetailPage() {
  const { id } = useParams()
  const cid = Number(id)
  const { can } = useAuth()
  const live = useLive()
  const controller = useQuery({ queryKey: ['controller', cid], queryFn: () => api.get<ControllerDto>(`/controllers/${cid}`) })
  const c = controller.data
  if (!c) return null
  const online = live.states[c.id]?.online ?? c.online
  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <>
            S/N {c.serial} · {c.host ?? 'broadcast'} · <Badge color={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Badge>
          </>
        }
      />
      <Tabs defaultValue="diagnostica" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="diagnostica">Diagnostica</Tabs.Tab>
          {can('admin') && <Tabs.Tab value="rete">Rete e configurazione</Tabs.Tab>}
          <Tabs.Tab value="avanzate">Impostazioni avanzate</Tabs.Tab>
          {can('admin') && <Tabs.Tab value="manutenzione">Manutenzione</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="diagnostica">
          <Diagnostics id={cid} />
        </Tabs.Panel>
        <Tabs.Panel value="rete">
          <Network c={c} />
        </Tabs.Panel>
        <Tabs.Panel value="avanzate">
          <AdvancedSettings id={cid} />
        </Tabs.Panel>
        <Tabs.Panel value="manutenzione">
          <Maintenance c={c} />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
