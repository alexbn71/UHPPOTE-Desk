import { Alert, Badge, Button, Card, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { IconPlus, IconRadar } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { treeOptions, useControllers, useZones } from '../lib/queries'

interface Discovered {
  controller: number
  address: string
  netmask: string
  gateway: string
  mac: string
  version: string
  date: string | null
  configured: number | null
}

export interface ControllerForm {
  serial: number | string
  name: string
  host: string
  port: number | string
  transport: 'udp' | 'tcp'
  zoneId: string | null
  enabled: boolean
}

export function ControllerFormFields({ form, setForm }: { form: ControllerForm; setForm: (f: ControllerForm) => void }) {
  const zones = useZones()
  return (
    <Stack>
      <NumberInput label="Numero di serie" description="9 cifre riportate sull'etichetta S/N della scheda" value={form.serial} onChange={(v) => setForm({ ...form, serial: v })} hideControls allowDecimal={false} required />
      <TextInput label="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required />
      <SimpleGrid cols={2}>
        <TextInput label="Indirizzo IP" description="Vuoto = comunicazione in broadcast" value={form.host} onChange={(e) => setForm({ ...form, host: e.currentTarget.value.trim() })} />
        <NumberInput label="Porta" value={form.port} onChange={(v) => setForm({ ...form, port: v })} min={1} max={65535} hideControls />
      </SimpleGrid>
      <SimpleGrid cols={2}>
        <Select
          label="Trasporto"
          data={[
            { value: 'udp', label: 'UDP (standard)' },
            { value: 'tcp', label: 'TCP (firmware recenti)' },
          ]}
          value={form.transport}
          onChange={(v) => setForm({ ...form, transport: (v as 'udp' | 'tcp') ?? 'udp' })}
        />
        <Select label="Zona" clearable data={treeOptions(zones.data)} value={form.zoneId} onChange={(v) => setForm({ ...form, zoneId: v })} />
      </SimpleGrid>
      <Switch label="Abilitato (monitoraggio e sincronizzazione)" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })} />
    </Stack>
  )
}

export function controllerBody(f: ControllerForm) {
  return {
    serial: Number(f.serial),
    name: f.name,
    host: f.host || null,
    port: Number(f.port) || 60000,
    transport: f.transport,
    zoneId: f.zoneId ? Number(f.zoneId) : null,
    enabled: f.enabled,
  }
}

export function ControllersPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { can } = useAuth()
  const live = useLive()
  const controllers = useControllers()
  const [form, setForm] = useState<ControllerForm | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [found, setFound] = useState<Discovered[] | null>(null)
  const [broadcast, setBroadcast] = useState('')

  const discover = async () => {
    setDiscovering(true)
    try {
      setFound(await api.get<Discovered[]>(`/discover${broadcast ? `?broadcast=${encodeURIComponent(broadcast)}` : ''}`))
    } catch (err) {
      notifyError(err)
    } finally {
      setDiscovering(false)
    }
  }

  const save = async () => {
    if (!form) return
    try {
      const r = await api.post<{ id: number }>('/controllers', controllerBody(form))
      notifyOk('Controller aggiunto')
      setForm(null)
      setFound(null)
      await qc.invalidateQueries({ queryKey: ['controllers'] })
      void qc.invalidateQueries({ queryKey: ['doors'] })
      navigate(`/controller/${r.id}`)
    } catch (err) {
      notifyError(err)
    }
  }

  return (
    <>
      <PageHeader
        title="Controller"
        description="Schede di controllo accessi UHPPOTE in rete"
        actions={
          can('admin') && (
            <>
              <Button variant="default" leftSection={<IconRadar size={16} />} onClick={() => setFound([])}>
                Cerca in rete
              </Button>
              <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ serial: '', name: '', host: '', port: 60000, transport: 'udp', zoneId: null, enabled: true })}>
                Aggiungi
              </Button>
            </>
          )
        }
      />
      <Card withBorder>
        <Table.ScrollContainer minWidth={700}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Nome</Table.Th>
                <Table.Th>S/N</Table.Th>
                <Table.Th>Indirizzo</Table.Th>
                <Table.Th>Firmware</Table.Th>
                <Table.Th>Stato</Table.Th>
                <Table.Th>Ultimo contatto</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(controllers.data ?? []).map((c) => {
                const state = live.states[c.id]
                const online = state?.online ?? c.online
                return (
                  <Table.Tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/controller/${c.id}`)}>
                    <Table.Td fw={600}>{c.name}</Table.Td>
                    <Table.Td className="mono">{c.serial}</Table.Td>
                    <Table.Td className="mono">
                      {c.host ? `${c.host}:${c.port}` : 'broadcast'} {c.transport === 'tcp' && <Badge size="xs">TCP</Badge>}
                    </Table.Td>
                    <Table.Td>{c.firmware ?? '—'}</Table.Td>
                    <Table.Td>
                      {!c.enabled ? <Badge color="gray">Disabilitato</Badge> : <Badge color={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Badge>}
                    </Table.Td>
                    <Table.Td>{fmtDateTime(state?.lastSeenAt ?? c.lastSeenAt)}</Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {controllers.data?.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            Nessun controller. Usa «Cerca in rete» per trovarli automaticamente.
          </Text>
        )}
      </Card>

      <Modal opened={found !== null} onClose={() => setFound(null)} title="Ricerca controller in rete" size="xl">
        <Stack>
          <Text size="sm" c="dimmed">
            La ricerca invia un broadcast UDP sulla porta 60000 e attende le risposte per qualche secondo. Funziona solo se il server è nella stessa rete
            (stesso segmento) della scheda.
          </Text>
          <Group align="flex-end">
            <TextInput label="Indirizzo di broadcast (opzionale)" placeholder="es. 192.168.1.255:60000" value={broadcast} onChange={(e) => setBroadcast(e.currentTarget.value)} />
            <Button onClick={() => void discover()} loading={discovering} leftSection={<IconRadar size={16} />}>
              Avvia ricerca
            </Button>
          </Group>
          {found && found.length > 0 && (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>S/N</Table.Th>
                  <Table.Th>IP</Table.Th>
                  <Table.Th>MAC</Table.Th>
                  <Table.Th>Firmware</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {found.map((f) => (
                  <Table.Tr key={f.controller}>
                    <Table.Td className="mono">{f.controller}</Table.Td>
                    <Table.Td className="mono">
                      {f.address}/{f.netmask} gw {f.gateway}
                    </Table.Td>
                    <Table.Td className="mono">{f.mac}</Table.Td>
                    <Table.Td>
                      {f.version} ({f.date ?? '?'})
                    </Table.Td>
                    <Table.Td>
                      {f.configured ? (
                        <Badge>Già configurato</Badge>
                      ) : (
                        <Button
                          size="xs"
                          onClick={() => {
                            setForm({ serial: f.controller, name: `Controller ${f.controller}`, host: f.address, port: 60000, transport: 'udp', zoneId: null, enabled: true })
                          }}
                        >
                          Aggiungi
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {found && found.length === 0 && !discovering && (
            <Alert color="gray">Nessun risultato (avvia la ricerca). Se la scheda non risponde verifica cavo, subnet, firewall (UDP 60000) e, in Docker, la modalità di rete «host».</Alert>
          )}
        </Stack>
      </Modal>

      <Modal opened={!!form} onClose={() => setForm(null)} title="Nuovo controller">
        {form && (
          <Stack>
            <ControllerFormFields form={form} setForm={setForm} />
            <Button onClick={() => void save()} disabled={!form.serial || !form.name}>
              Salva
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
