import { Badge, Button, Card, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Tooltip } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { IconCalendarPlus, IconDownload, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { AttendanceDayDto } from '@uhppote-desk/shared'
import { LEAVE_TYPE_LABELS } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput, weekdaysText } from '../components/common'
import { api, notifyError, notifyOk, qs } from '../lib/api'
import { useAuth } from '../lib/auth'
import { addDays, fmtDate, fmtDateTime, fmtMinutes, today } from '../lib/format'
import { treeOptions, useDepartments, usePeople, useShifts, type Shift } from '../lib/queries'

const STATUS_COLORS: Record<AttendanceDayDto['status'], string> = {
  presente: 'green',
  assente: 'red',
  festivo: 'grape',
  riposo: 'gray',
  ferie: 'cyan',
  permesso: 'cyan',
  malattia: 'orange',
  trasferta: 'blue',
  altro: 'gray',
  anomalia: 'yellow',
}

function Report() {
  const people = usePeople()
  const departments = useDepartments()
  const firstOfMonth = today().slice(0, 8) + '01'
  const [from, setFrom] = useState<string | null>(firstOfMonth)
  const [to, setTo] = useState<string | null>(today())
  const [personId, setPersonId] = useState<string | null>(null)
  const [departmentId, setDepartmentId] = useState<string | null>(null)
  const params = { from, to, personId, departmentId }
  const report = useQuery({
    queryKey: ['attendance', params],
    queryFn: () => api.get<AttendanceDayDto[]>(`/attendance/report${qs(params)}`),
    enabled: !!from && !!to,
  })

  const totals = useMemo(() => {
    const m = new Map<number, { name: string; worked: number; expected: number; late: number; overtime: number; absent: number; anomalies: number }>()
    for (const d of report.data ?? []) {
      const t = m.get(d.personId) ?? { name: d.personName, worked: 0, expected: 0, late: 0, overtime: 0, absent: 0, anomalies: 0 }
      t.worked += d.workedMinutes
      t.expected += d.expectedMinutes
      t.late += d.lateMinutes
      t.overtime += d.overtimeMinutes
      if (d.status === 'assente') t.absent++
      if (d.anomalies.length) t.anomalies++
      m.set(d.personId, t)
    }
    return [...m.values()]
  }, [report.data])

  return (
    <Stack>
      <Card withBorder>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }}>
          <DateInput label="Dal" valueFormat="DD/MM/YYYY" value={from} onChange={setFrom} />
          <DateInput label="Al" valueFormat="DD/MM/YYYY" value={to} onChange={setTo} />
          <Select label="Reparto" clearable data={treeOptions(departments.data)} value={departmentId} onChange={setDepartmentId} />
          <Select
            label="Persona"
            clearable
            searchable
            data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))}
            value={personId}
            onChange={setPersonId}
          />
          <Button mt={24} component="a" href={`/api/attendance/report.csv${qs(params)}`} leftSection={<IconDownload size={16} />} variant="default">
            Esporta CSV
          </Button>
        </SimpleGrid>
      </Card>
      <Card withBorder>
        <Text fw={600} mb="xs">
          Riepilogo del periodo
        </Text>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Persona</Table.Th>
                <Table.Th>Ore lavorate</Table.Th>
                <Table.Th>Ore previste</Table.Th>
                <Table.Th>Straordinario</Table.Th>
                <Table.Th>Ritardi</Table.Th>
                <Table.Th>Assenze</Table.Th>
                <Table.Th>Anomalie</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {totals.map((t) => (
                <Table.Tr key={t.name}>
                  <Table.Td>{t.name}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(t.worked)}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(t.expected)}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(t.overtime)}</Table.Td>
                  <Table.Td className="mono">{t.late ? fmtMinutes(t.late) : '—'}</Table.Td>
                  <Table.Td>{t.absent || '—'}</Table.Td>
                  <Table.Td>{t.anomalies ? <Badge color="yellow">{t.anomalies}</Badge> : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Card withBorder>
        <Text fw={600} mb="xs">
          Dettaglio giornaliero
        </Text>
        <Table.ScrollContainer minWidth={900}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Persona</Table.Th>
                <Table.Th>Data</Table.Th>
                <Table.Th>Stato</Table.Th>
                <Table.Th>Entrata</Table.Th>
                <Table.Th>Uscita</Table.Th>
                <Table.Th>Lavorate</Table.Th>
                <Table.Th>Ritardo</Table.Th>
                <Table.Th>Timbrature</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(report.data ?? [])
                .filter((d) => d.status !== 'riposo' || d.punches.length > 0)
                .map((d) => (
                  <Table.Tr key={`${d.personId}-${d.date}`}>
                    <Table.Td>{d.personName}</Table.Td>
                    <Table.Td>{fmtDate(d.date)}</Table.Td>
                    <Table.Td>
                      <Tooltip label={d.anomalies.join(', ')} disabled={!d.anomalies.length}>
                        <Badge color={STATUS_COLORS[d.status]} variant="light">
                          {d.status}
                        </Badge>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td className="mono">{d.firstIn ?? '—'}</Table.Td>
                    <Table.Td className="mono">{d.lastOut ?? '—'}</Table.Td>
                    <Table.Td className="mono">{fmtMinutes(d.workedMinutes)}</Table.Td>
                    <Table.Td className="mono">{d.lateMinutes ? `${d.lateMinutes} min` : '—'}</Table.Td>
                    <Table.Td className="mono">{d.punches.map((p) => `${p.time}${p.source === 'manuale' ? '*' : ''}`).join('  ')}</Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Text size="xs" c="dimmed" mt="xs">
          * timbratura inserita manualmente. Sono considerati solo i passaggi consentiti sui lettori marcati «presenze» (pagina Porte).
        </Text>
      </Card>
    </Stack>
  )
}

function Shifts() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const shifts = useShifts()
  const [edit, setEdit] = useState<(Omit<Shift, 'id'> & { id?: number }) | null>(null)
  const save = async () => {
    if (!edit) return
    try {
      const { id, ...body } = edit
      if (id) await api.put(`/shifts/${id}`, body)
      else await api.post('/shifts', body)
      setEdit(null)
      void qc.invalidateQueries({ queryKey: ['shifts'] })
    } catch (err) {
      notifyError(err)
    }
  }
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Text size="sm" c="dimmed">
          Il turno si assegna nella scheda della persona. I turni con fine inferiore all'inizio sono notturni.
        </Text>
        {can('operator') && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit({ name: '', startTime: '08:30', endTime: '17:30', breakMinutes: 60, toleranceMinutes: 10, weekdays: [true, true, true, true, true, false, false] })}>
            Nuovo turno
          </Button>
        )}
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Nome</Table.Th>
            <Table.Th>Orario</Table.Th>
            <Table.Th>Pausa</Table.Th>
            <Table.Th>Tolleranza</Table.Th>
            <Table.Th>Giorni</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(shifts.data ?? []).map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.name}</Table.Td>
              <Table.Td className="mono">
                {s.startTime}–{s.endTime}
              </Table.Td>
              <Table.Td>{s.breakMinutes} min</Table.Td>
              <Table.Td>{s.toleranceMinutes} min</Table.Td>
              <Table.Td>{weekdaysText(s.weekdays)}</Table.Td>
              <Table.Td>
                {can('operator') && (
                  <Group gap={0} justify="flex-end">
                    <IconButton label="Modifica" onClick={() => setEdit(s)}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label="Elimina" color="red" onClick={() => void api.del(`/shifts/${s.id}`).then(() => qc.invalidateQueries({ queryKey: ['shifts'] })).catch(notifyError)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!edit} onClose={() => setEdit(null)} title="Turno">
        {edit && (
          <Stack>
            <TextInput label="Nome" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
            <SimpleGrid cols={2}>
              <TextInput label="Inizio (HH:mm)" value={edit.startTime} onChange={(e) => setEdit({ ...edit, startTime: e.currentTarget.value })} />
              <TextInput label="Fine (HH:mm)" value={edit.endTime} onChange={(e) => setEdit({ ...edit, endTime: e.currentTarget.value })} />
              <NumberInput label="Pausa (minuti)" min={0} value={edit.breakMinutes} onChange={(v) => setEdit({ ...edit, breakMinutes: Number(v) || 0 })} />
              <NumberInput label="Tolleranza (minuti)" min={0} value={edit.toleranceMinutes} onChange={(v) => setEdit({ ...edit, toleranceMinutes: Number(v) || 0 })} />
            </SimpleGrid>
            <WeekdaysInput label="Giorni lavorativi" value={edit.weekdays} onChange={(w) => setEdit({ ...edit, weekdays: w })} />
            <Button onClick={() => void save()} disabled={!edit.name}>
              Salva
            </Button>
          </Stack>
        )}
      </Modal>
    </Card>
  )
}

function Holidays() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const holidays = useQuery({ queryKey: ['holidays'], queryFn: () => api.get<{ date: string; name: string }[]>('/holidays') })
  const [date, setDate] = useState<string | null>(null)
  const [name, setName] = useState('')
  const year = new Date().getFullYear()
  const refresh = () => qc.invalidateQueries({ queryKey: ['holidays'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <Group align="flex-end" mb="md">
          <DateInput label="Data" valueFormat="DD/MM/YYYY" value={date} onChange={setDate} />
          <TextInput label="Descrizione" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button disabled={!date || !name} onClick={() => void api.post('/holidays', { date, name }).then(() => { setName(''); void refresh() }).catch(notifyError)}>
            Aggiungi
          </Button>
          {[year, year + 1].map((y) => (
            <Button key={y} variant="default" leftSection={<IconCalendarPlus size={16} />} onClick={() => void api.post(`/holidays/italian/${y}`).then(() => { notifyOk(`Festività ${y} importate`); void refresh() }).catch(notifyError)}>
              Festività nazionali {y}
            </Button>
          ))}
        </Group>
      )}
      <Table>
        <Table.Tbody>
          {(holidays.data ?? []).map((h) => (
            <Table.Tr key={h.date}>
              <Table.Td w={140}>{fmtDate(h.date)}</Table.Td>
              <Table.Td>{h.name}</Table.Td>
              <Table.Td w={50}>
                {can('operator') && (
                  <IconButton label="Elimina" color="red" onClick={() => void api.del(`/holidays/${h.date}`).then(refresh).catch(notifyError)}>
                    <IconTrash size={16} />
                  </IconButton>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

function Leaves() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const leaves = useQuery({
    queryKey: ['leaves'],
    queryFn: () => api.get<{ id: number; personName: string; fromDate: string; toDate: string; type: keyof typeof LEAVE_TYPE_LABELS; notes: string }[]>('/leaves'),
  })
  const [form, setForm] = useState({ personId: null as string | null, fromDate: today() as string | null, toDate: today() as string | null, type: 'ferie', notes: '' })
  const refresh = () => qc.invalidateQueries({ queryKey: ['leaves'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <SimpleGrid cols={{ base: 1, md: 6 }} mb="md">
          <Select label="Persona" searchable data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))} value={form.personId} onChange={(v) => setForm({ ...form, personId: v })} />
          <DateInput label="Dal" valueFormat="DD/MM/YYYY" value={form.fromDate} onChange={(v) => setForm({ ...form, fromDate: v })} />
          <DateInput label="Al" valueFormat="DD/MM/YYYY" value={form.toDate} onChange={(v) => setForm({ ...form, toDate: v })} />
          <Select label="Tipo" data={Object.entries(LEAVE_TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))} value={form.type} onChange={(v) => setForm({ ...form, type: v ?? 'ferie' })} />
          <TextInput label="Note" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })} />
          <Button
            mt={24}
            disabled={!form.personId || !form.fromDate || !form.toDate}
            onClick={() => void api.post('/leaves', { ...form, personId: Number(form.personId) }).then(() => { void refresh() }).catch(notifyError)}
          >
            Aggiungi
          </Button>
        </SimpleGrid>
      )}
      <Table>
        <Table.Tbody>
          {(leaves.data ?? []).map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td>{l.personName}</Table.Td>
              <Table.Td>
                {fmtDate(l.fromDate)} – {fmtDate(l.toDate)}
              </Table.Td>
              <Table.Td>
                <Badge variant="light">{LEAVE_TYPE_LABELS[l.type]}</Badge>
              </Table.Td>
              <Table.Td>{l.notes}</Table.Td>
              <Table.Td w={50}>
                {can('operator') && (
                  <IconButton label="Elimina" color="red" onClick={() => void api.del(`/leaves/${l.id}`).then(refresh).catch(notifyError)}>
                    <IconTrash size={16} />
                  </IconButton>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

function ManualPunches() {
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const [range] = useState({ from: addDays(today(), -31), to: today() })
  const punches = useQuery({
    queryKey: ['punches', range],
    queryFn: () => api.get<{ id: number; personName: string; timestamp: string; direction: number; reason: string; operator: string | null }[]>(`/punches${qs(range)}`),
  })
  const [form, setForm] = useState({ personId: null as string | null, date: today() as string | null, time: '08:30', direction: '1', reason: '' })
  const refresh = () => qc.invalidateQueries({ queryKey: ['punches'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <SimpleGrid cols={{ base: 1, md: 6 }} mb="md">
          <Select label="Persona" searchable data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))} value={form.personId} onChange={(v) => setForm({ ...form, personId: v })} />
          <DateInput label="Data" valueFormat="DD/MM/YYYY" value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
          <TextInput label="Ora" value={form.time} onChange={(e) => setForm({ ...form, time: e.currentTarget.value })} />
          <Select label="Verso" data={[{ value: '1', label: 'Ingresso' }, { value: '2', label: 'Uscita' }]} value={form.direction} onChange={(v) => setForm({ ...form, direction: v ?? '1' })} />
          <TextInput label="Motivazione" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })} />
          <Button
            mt={24}
            disabled={!form.personId || !form.date || !form.reason}
            onClick={() =>
              void api
                .post('/punches', { personId: Number(form.personId), timestamp: `${form.date} ${form.time}`, direction: Number(form.direction), reason: form.reason })
                .then(() => {
                  setForm({ ...form, reason: '' })
                  void refresh()
                })
                .catch(notifyError)
            }
          >
            Aggiungi
          </Button>
        </SimpleGrid>
      )}
      <Table>
        <Table.Tbody>
          {(punches.data ?? []).map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>{p.personName}</Table.Td>
              <Table.Td className="mono">{fmtDateTime(p.timestamp)}</Table.Td>
              <Table.Td>{p.direction === 1 ? 'Ingresso' : 'Uscita'}</Table.Td>
              <Table.Td>{p.reason}</Table.Td>
              <Table.Td c="dimmed">{p.operator}</Table.Td>
              <Table.Td w={50}>
                {can('operator') && (
                  <IconButton label="Elimina" color="red" onClick={() => void api.del(`/punches/${p.id}`).then(refresh).catch(notifyError)}>
                    <IconTrash size={16} />
                  </IconButton>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  )
}

export function AttendancePage() {
  return (
    <>
      <PageHeader title="Presenze" description="Ore lavorate calcolate dai passaggi sui lettori presenze, con turni, festività e assenze" />
      <Tabs defaultValue="report" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="report">Report</Tabs.Tab>
          <Tabs.Tab value="turni">Turni</Tabs.Tab>
          <Tabs.Tab value="festivita">Festività</Tabs.Tab>
          <Tabs.Tab value="assenze">Ferie e assenze</Tabs.Tab>
          <Tabs.Tab value="manuali">Timbrature manuali</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="report">
          <Report />
        </Tabs.Panel>
        <Tabs.Panel value="turni">
          <Shifts />
        </Tabs.Panel>
        <Tabs.Panel value="festivita">
          <Holidays />
        </Tabs.Panel>
        <Tabs.Panel value="assenze">
          <Leaves />
        </Tabs.Panel>
        <Tabs.Panel value="manuali">
          <ManualPunches />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
