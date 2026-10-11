import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  FileButton,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { useDebouncedValue } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import { IconFileImport, IconPhoto, IconPlus, IconSearch, IconTrash, IconUser } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PersonDto } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk, notifyPush } from '../lib/api'
import { useAuth } from '../lib/auth'
import { addDays, cardLabel, fmtDate, today } from '../lib/format'
import { treeOptions, useControllers, useDepartments, useShifts, useTimeProfiles, type Permission } from '../lib/queries'

type PersonForm = Omit<PersonDto, 'id' | 'departmentName' | 'hasPhoto' | 'cards'>

const emptyPerson = (): PersonForm => ({
  code: '',
  firstName: '',
  lastName: '',
  departmentId: null,
  email: '',
  phone: '',
  notes: '',
  pin: 0,
  validFrom: today(),
  validTo: addDays(today(), 3650),
  active: true,
  shiftId: null,
})

function PermissionsEditor({ personId, readOnly }: { personId: number; readOnly: boolean }) {
  const qc = useQueryClient()
  const controllers = useControllers()
  const profiles = useTimeProfiles()
  const person = useQuery({ queryKey: ['person', personId], queryFn: () => api.get<PersonDto & { permissions: Permission[] }>(`/people/${personId}`) })
  const [perms, setPerms] = useState<Map<number, Permission>>(new Map())
  const [busy, setBusy] = useState(false)
  const controllerName = (id: number) => controllers.data?.find((c) => c.id === id)?.name ?? `#${id}`

  useEffect(() => {
    if (person.data) setPerms(new Map(person.data.permissions.map((p) => [p.doorId, p])))
  }, [person.data])

  const profileOptions = [{ value: 'always', label: 'Sempre' }, ...(profiles.data ?? []).map((p) => ({ value: String(p.id), label: `${p.id} · ${p.name}` }))]

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.put<{ pushErrors: { controllerId: number; error: string }[] }>(`/people/${personId}/permissions`, {
        permissions: [...perms.values()].map((p) => ({ doorId: p.doorId, profileId: p.profileId, firstCard: p.firstCard })),
      })
      notifyOk('Permessi salvati e inviati ai controller')
      notifyPush(r, controllerName)
      void qc.invalidateQueries({ queryKey: ['person', personId] })
      void qc.invalidateQueries({ queryKey: ['permissions'] })
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack>
      {(controllers.data ?? []).map((c) => (
        <Card withBorder key={c.id} padding="sm">
          <Text fw={600} mb="xs">
            {c.name}
          </Text>
          <Table>
            <Table.Tbody>
              {c.doors.map((d) => {
                const p = perms.get(d.id)
                return (
                  <Table.Tr key={d.id}>
                    <Table.Td>
                      <Checkbox
                        label={d.name}
                        checked={!!p}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = new Map(perms)
                          if (e.currentTarget.checked) next.set(d.id, { personId, doorId: d.id, profileId: null, firstCard: false })
                          else next.delete(d.id)
                          setPerms(next)
                        }}
                      />
                    </Table.Td>
                    <Table.Td w={220}>
                      {p && (
                        <Select
                          size="xs"
                          data={profileOptions}
                          value={p.profileId === null ? 'always' : String(p.profileId)}
                          disabled={readOnly}
                          onChange={(v) => setPerms(new Map(perms).set(d.id, { ...p, profileId: !v || v === 'always' ? null : Number(v) }))}
                        />
                      )}
                    </Table.Td>
                    <Table.Td w={120}>
                      {p && (
                        <Checkbox
                          size="xs"
                          label="First card"
                          checked={p.firstCard}
                          disabled={readOnly}
                          onChange={(e) => setPerms(new Map(perms).set(d.id, { ...p, firstCard: e.currentTarget.checked }))}
                        />
                      )}
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Card>
      ))}
      {!readOnly && (
        <Button onClick={save} loading={busy}>
          Salva permessi
        </Button>
      )}
    </Stack>
  )
}

function CardsEditor({ person, readOnly, onChange }: { person: PersonDto; readOnly: boolean; onChange: () => void }) {
  const [number, setNumber] = useState<number | string>('')
  const unknown = useQuery({
    queryKey: ['cards-unknown'],
    queryFn: () => api.get<{ card: number; timestamp: string }[]>('/cards/unknown?minutes=10'),
    refetchInterval: 3000,
    enabled: !readOnly,
  })

  const add = async (n: number) => {
    try {
      const r = await api.post<{ pushErrors: { controllerId: number; error: string }[] }>('/cards', { number: n, personId: person.id })
      notifyOk(`Tessera ${n} assegnata`)
      notifyPush(r)
      setNumber('')
      onChange()
    } catch (err) {
      notifyError(err)
    }
  }

  const replace = (cardId: number, old: number) => {
    let value = ''
    modals.openConfirmModal({
      title: `Tessera smarrita ${old}`,
      children: (
        <Stack>
          <Text size="sm">La tessera verrà disattivata e rimossa dai controller; la nuova tessera riceverà gli stessi permessi.</Text>
          <TextInput label="Numero nuova tessera" onChange={(e) => (value = e.currentTarget.value)} />
        </Stack>
      ),
      labels: { confirm: 'Sostituisci', cancel: 'Annulla' },
      onConfirm: () =>
        api
          .post<{ pushErrors: { controllerId: number; error: string }[] }>(`/cards/${cardId}/replace`, { newNumber: Number(value) })
          .then((r) => {
            notifyOk('Tessera sostituita')
            notifyPush(r)
            onChange()
          })
          .catch(notifyError),
    })
  }

  const remove = (cardId: number, n: number) =>
    modals.openConfirmModal({
      title: 'Elimina tessera',
      children: <Text size="sm">Eliminare la tessera {n}? Verrà rimossa da tutti i controller.</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<{ pushErrors: { controllerId: number; error: string }[] }>(`/cards/${cardId}`)
          .then((r) => {
            notifyPush(r)
            onChange()
          })
          .catch(notifyError),
    })

  return (
    <Stack>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Numero (facility, codice)</Table.Th>
            <Table.Th>Stato</Table.Th>
            <Table.Th>Dal</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {person.cards.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td className="mono">{cardLabel(c.number)}</Table.Td>
              <Table.Td>
                <Badge color={c.status === 'active' ? 'green' : c.status === 'lost' ? 'red' : 'gray'} variant="light">
                  {c.status === 'active' ? 'Attiva' : c.status === 'lost' ? 'Smarrita' : 'Disattivata'}
                </Badge>
              </Table.Td>
              <Table.Td>{fmtDate(c.createdAt)}</Table.Td>
              <Table.Td>
                {!readOnly && (
                  <Group gap={4} justify="flex-end">
                    {c.status === 'active' && (
                      <Button size="compact-xs" variant="light" color="orange" onClick={() => replace(c.id, c.number)}>
                        Smarrita
                      </Button>
                    )}
                    <IconButton label="Elimina" color="red" onClick={() => remove(c.id, c.number)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {!readOnly && (
        <>
          <Group align="flex-end">
            <NumberInput label="Aggiungi tessera" description="Numero a 8 cifre (facility × 100000 + codice)" value={number} onChange={setNumber} hideControls allowDecimal={false} w={260} />
            <Button disabled={!number} onClick={() => void add(Number(number))}>
              Aggiungi
            </Button>
          </Group>
          <Alert variant="light" title="Acquisizione da lettore">
            Passa la tessera su un lettore qualsiasi: le tessere non registrate lette negli ultimi 10 minuti compaiono qui.
            <Group gap="xs" mt="xs">
              {(unknown.data ?? []).map((u) => (
                <Button key={u.card} size="compact-sm" variant="outline" onClick={() => void add(u.card)}>
                  {cardLabel(u.card)}
                </Button>
              ))}
              {unknown.data?.length === 0 && <Text size="sm" c="dimmed">Nessuna tessera sconosciuta letta di recente.</Text>}
            </Group>
          </Alert>
        </>
      )}
    </Stack>
  )
}

function PersonDrawer({ person, opened, onClose }: { person: PersonDto | null; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { can } = useAuth()
  const readOnly = !can('operator')
  const departments = useDepartments()
  const shifts = useShifts()
  const [form, setForm] = useState<PersonForm>(emptyPerson())
  const [busy, setBusy] = useState(false)
  const [photoKey, setPhotoKey] = useState(0)
  const current = useQuery({
    queryKey: ['person', person?.id],
    queryFn: () => api.get<PersonDto>(`/people/${person!.id}`),
    enabled: !!person,
  })

  useEffect(() => {
    if (!opened) return
    if (person) {
      const { id: _id, departmentName: _d, hasPhoto: _h, cards: _c, ...rest } = person
      setForm(rest)
    } else setForm(emptyPerson())
  }, [person, opened])

  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['people'] })
    void qc.invalidateQueries({ queryKey: ['person', person?.id] })
  }

  const save = async () => {
    setBusy(true)
    try {
      if (person) {
        const r = await api.put<{ pushErrors: { controllerId: number; error: string }[] }>(`/people/${person.id}`, form)
        notifyPush(r)
        notifyOk('Persona aggiornata')
      } else {
        await api.post('/people', form)
        notifyOk('Persona creata: ora puoi assegnare tessere e permessi')
      }
      refresh()
      if (!person) onClose()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(false)
    }
  }

  const uploadPhoto = async (file: File | null) => {
    if (!file || !person) return
    try {
      await api.upload(`/people/${person.id}/photo`, file, 'PUT')
      setPhotoKey((k) => k + 1)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const p = current.data ?? person
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={person ? `${person.lastName} ${person.firstName}` : 'Nuova persona'}>
      <Tabs defaultValue="anagrafica">
        <Tabs.List mb="md">
          <Tabs.Tab value="anagrafica">Anagrafica</Tabs.Tab>
          <Tabs.Tab value="tessere" disabled={!person}>
            Tessere {p ? `(${p.cards.length})` : ''}
          </Tabs.Tab>
          <Tabs.Tab value="permessi" disabled={!person}>
            Permessi
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="anagrafica">
          <Stack>
            {person && (
              <Group>
                <Avatar src={p?.hasPhoto ? `/api/people/${person.id}/photo?k=${photoKey}` : null} size={96} radius="md">
                  <IconUser size={48} />
                </Avatar>
                {!readOnly && (
                  <FileButton onChange={(f) => void uploadPhoto(f)} accept="image/jpeg,image/png,image/webp">
                    {(props) => (
                      <Button {...props} variant="light" leftSection={<IconPhoto size={16} />}>
                        Carica foto
                      </Button>
                    )}
                  </FileButton>
                )}
              </Group>
            )}
            <SimpleGrid cols={2}>
              <TextInput label="Matricola" required value={form.code} onChange={(e) => set('code', e.currentTarget.value)} readOnly={readOnly} />
              <Select
                label="Reparto"
                clearable
                searchable
                data={treeOptions(departments.data)}
                value={form.departmentId ? String(form.departmentId) : null}
                onChange={(v) => set('departmentId', v ? Number(v) : null)}
                readOnly={readOnly}
              />
              <TextInput label="Cognome" required value={form.lastName} onChange={(e) => set('lastName', e.currentTarget.value)} readOnly={readOnly} />
              <TextInput label="Nome" value={form.firstName} onChange={(e) => set('firstName', e.currentTarget.value)} readOnly={readOnly} />
              <TextInput label="Email" value={form.email} onChange={(e) => set('email', e.currentTarget.value)} readOnly={readOnly} />
              <TextInput label="Telefono" value={form.phone} onChange={(e) => set('phone', e.currentTarget.value)} readOnly={readOnly} />
              <DateInput label="Accesso valido dal" valueFormat="DD/MM/YYYY" value={form.validFrom} onChange={(v) => v && set('validFrom', v)} readOnly={readOnly} />
              <DateInput label="Accesso valido al" valueFormat="DD/MM/YYYY" value={form.validTo} onChange={(v) => v && set('validTo', v)} readOnly={readOnly} />
              <NumberInput
                label="PIN tastiera"
                description="0 = nessun PIN (max 6 cifre)"
                min={0}
                max={999999}
                value={form.pin}
                onChange={(v) => set('pin', Number(v) || 0)}
                readOnly={readOnly}
                hideControls
              />
              <Select
                label="Turno (presenze)"
                clearable
                data={(shifts.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.startTime}-${s.endTime})` }))}
                value={form.shiftId ? String(form.shiftId) : null}
                onChange={(v) => set('shiftId', v ? Number(v) : null)}
                readOnly={readOnly}
              />
            </SimpleGrid>
            <Textarea label="Note" value={form.notes} onChange={(e) => set('notes', e.currentTarget.value)} readOnly={readOnly} autosize minRows={2} />
            <Switch label="Attivo (se disattivato le tessere vengono rimosse dai controller)" checked={form.active} onChange={(e) => set('active', e.currentTarget.checked)} disabled={readOnly} />
            {!readOnly && (
              <Button onClick={save} loading={busy}>
                {person ? 'Salva modifiche' : 'Crea persona'}
              </Button>
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="tessere">{p && <CardsEditor person={p} readOnly={readOnly} onChange={refresh} />}</Tabs.Panel>
        <Tabs.Panel value="permessi">{person && <PermissionsEditor personId={person.id} readOnly={readOnly} />}</Tabs.Panel>
      </Tabs>
    </Drawer>
  )
}

export function PeoplePage() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const [search, setSearch] = useState('')
  const [debounced] = useDebouncedValue(search, 300)
  const people = useQuery({ queryKey: ['people', debounced], queryFn: () => api.get<PersonDto[]>(`/people${debounced ? `?search=${encodeURIComponent(debounced)}` : ''}`) })
  const [selected, setSelected] = useState<PersonDto | null>(null)
  const [opened, setOpened] = useState(false)

  const importCsv = async (file: File | null) => {
    if (!file) return
    try {
      const r = await api.upload<{ created: number; updated: number; cards: number; errors: { row: number; error: string }[] }>('/people/import', file)
      modals.open({
        title: 'Risultato importazione',
        children: (
          <Stack>
            <Text>
              Create: {r.created} · Aggiornate: {r.updated} · Tessere: {r.cards}
            </Text>
            {r.errors.length > 0 && (
              <Alert color="orange" title={`${r.errors.length} righe con errori`}>
                {r.errors.slice(0, 20).map((e) => (
                  <Text size="sm" key={e.row}>
                    Riga {e.row}: {e.error}
                  </Text>
                ))}
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              Ricorda di assegnare i permessi alle persone importate.
            </Text>
          </Stack>
        ),
      })
      void qc.invalidateQueries({ queryKey: ['people'] })
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (p: PersonDto) =>
    modals.openConfirmModal({
      title: 'Elimina persona',
      children: <Text size="sm">Eliminare {p.lastName} {p.firstName}? Le sue tessere verranno eliminate e rimosse dai controller.</Text>,
      labels: { confirm: 'Elimina', cancel: 'Annulla' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del<{ pushErrors: { controllerId: number; error: string }[] }>(`/people/${p.id}`)
          .then((r) => {
            notifyPush(r)
            void qc.invalidateQueries({ queryKey: ['people'] })
          })
          .catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title="Persone"
        description="Anagrafica utenti, tessere e permessi di accesso"
        actions={
          can('operator') && (
            <>
              <FileButton onChange={(f) => void importCsv(f)} accept=".csv,text/csv">
                {(props) => (
                  <Button {...props} variant="default" leftSection={<IconFileImport size={16} />}>
                    Importa CSV
                  </Button>
                )}
              </FileButton>
              <Button
                leftSection={<IconPlus size={16} />}
                onClick={() => {
                  setSelected(null)
                  setOpened(true)
                }}
              >
                Nuova persona
              </Button>
            </>
          )
        }
      />
      <Card withBorder>
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="Cerca per nome, matricola o numero tessera"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          mb="md"
        />
        <Table.ScrollContainer minWidth={700}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Matricola</Table.Th>
                <Table.Th>Nome</Table.Th>
                <Table.Th>Reparto</Table.Th>
                <Table.Th>Tessere</Table.Th>
                <Table.Th>Validità</Table.Th>
                <Table.Th>Stato</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(people.data ?? []).map((p) => (
                <Table.Tr
                  key={p.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSelected(p)
                    setOpened(true)
                  }}
                >
                  <Table.Td className="mono">{p.code}</Table.Td>
                  <Table.Td>
                    {p.lastName} {p.firstName}
                  </Table.Td>
                  <Table.Td>{p.departmentName ?? '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {p.cards.map((c) => (
                        <Badge key={c.id} variant="light" color={c.status === 'active' ? 'blue' : 'gray'} className="mono">
                          {c.number}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {fmtDate(p.validFrom)} – {fmtDate(p.validTo)}
                  </Table.Td>
                  <Table.Td>
                    <Badge color={p.active ? 'green' : 'gray'} variant="light">
                      {p.active ? 'Attivo' : 'Disattivato'}
                    </Badge>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    {can('operator') && (
                      <ActionIcon variant="subtle" color="red" onClick={() => remove(p)} aria-label="Elimina">
                        <IconTrash size={16} />
                      </ActionIcon>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {people.data?.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            Nessuna persona trovata
          </Text>
        )}
      </Card>
      <PersonDrawer person={selected} opened={opened} onClose={() => setOpened(false)} />
    </>
  )
}
