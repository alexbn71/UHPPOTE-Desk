import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { IconCalendarPlus, IconDownload, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttendanceDayDto } from '@uhppote-desk/shared'
import { LEAVE_TYPES } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput } from '../components/common'
import { api, downloadQs, notifyError, notifyOk, qs } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useCodes } from '../lib/codes'
import { DATE_INPUT_FORMAT, addDays, fmtDate, fmtDateTime, fmtMinutes, today } from '../lib/format'
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
  const { t } = useTranslation()
  const codes = useCodes()
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
    const m = new Map<
      number,
      {
        name: string
        worked: number
        expected: number
        late: number
        overtime: number
        absent: number
        anomalies: number
      }
    >()
    for (const d of report.data ?? []) {
      const x = m.get(d.personId) ?? {
        name: d.personName,
        worked: 0,
        expected: 0,
        late: 0,
        overtime: 0,
        absent: 0,
        anomalies: 0,
      }
      x.worked += d.workedMinutes
      x.expected += d.expectedMinutes
      x.late += d.lateMinutes
      x.overtime += d.overtimeMinutes
      if (d.status === 'assente') x.absent++
      if (d.anomalies.length) x.anomalies++
      m.set(d.personId, x)
    }
    return [...m.values()]
  }, [report.data])

  return (
    <Stack>
      <Card withBorder>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }}>
          <DateInput label={t('common.from')} valueFormat={DATE_INPUT_FORMAT} value={from} onChange={setFrom} />
          <DateInput label={t('common.to')} valueFormat={DATE_INPUT_FORMAT} value={to} onChange={setTo} />
          <Select
            label={t('attendance.department')}
            clearable
            data={treeOptions(departments.data)}
            value={departmentId}
            onChange={setDepartmentId}
          />
          <Select
            label={t('attendance.person')}
            clearable
            searchable
            data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))}
            value={personId}
            onChange={setPersonId}
          />
          <Button
            mt={24}
            component="a"
            href={`/api/attendance/report.csv${downloadQs(params)}`}
            leftSection={<IconDownload size={16} />}
            variant="default"
          >
            {t('common.exportCsv')}
          </Button>
        </SimpleGrid>
      </Card>
      <Card withBorder>
        <Text fw={600} mb="xs">
          {t('attendance.summary')}
        </Text>
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('attendance.colPerson')}</Table.Th>
                <Table.Th>{t('attendance.colWorked')}</Table.Th>
                <Table.Th>{t('attendance.colExpected')}</Table.Th>
                <Table.Th>{t('attendance.colOvertime')}</Table.Th>
                <Table.Th>{t('attendance.colLate')}</Table.Th>
                <Table.Th>{t('attendance.colAbsent')}</Table.Th>
                <Table.Th>{t('attendance.colAnomalies')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {totals.map((x) => (
                <Table.Tr key={x.name}>
                  <Table.Td>{x.name}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(x.worked)}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(x.expected)}</Table.Td>
                  <Table.Td className="mono">{fmtMinutes(x.overtime)}</Table.Td>
                  <Table.Td className="mono">{x.late ? fmtMinutes(x.late) : '—'}</Table.Td>
                  <Table.Td>{x.absent || '—'}</Table.Td>
                  <Table.Td>{x.anomalies ? <Badge color="yellow">{x.anomalies}</Badge> : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Card withBorder>
        <Text fw={600} mb="xs">
          {t('attendance.detail')}
        </Text>
        <Table.ScrollContainer minWidth={900}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('attendance.colPerson')}</Table.Th>
                <Table.Th>{t('attendance.colDate')}</Table.Th>
                <Table.Th>{t('attendance.colStatus')}</Table.Th>
                <Table.Th>{t('attendance.colIn')}</Table.Th>
                <Table.Th>{t('attendance.colOut')}</Table.Th>
                <Table.Th>{t('attendance.colWorkedShort')}</Table.Th>
                <Table.Th>{t('attendance.colLateShort')}</Table.Th>
                <Table.Th>{t('attendance.colPunches')}</Table.Th>
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
                      <Tooltip
                        label={d.anomalies.map((a) => codes.anomaly(a)).join(', ')}
                        disabled={!d.anomalies.length}
                      >
                        <Badge color={STATUS_COLORS[d.status]} variant="light">
                          {codes.attendanceStatus(d.status)}
                        </Badge>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td className="mono">{d.firstIn ?? '—'}</Table.Td>
                    <Table.Td className="mono">{d.lastOut ?? '—'}</Table.Td>
                    <Table.Td className="mono">{fmtMinutes(d.workedMinutes)}</Table.Td>
                    <Table.Td className="mono">
                      {d.lateMinutes ? t('attendance.lateMinutes', { n: d.lateMinutes }) : '—'}
                    </Table.Td>
                    <Table.Td className="mono">
                      {d.punches.map((p) => `${p.time}${p.source === 'manuale' ? '*' : ''}`).join('  ')}
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Text size="xs" c="dimmed" mt="xs">
          {t('attendance.footnote')}
        </Text>
      </Card>
    </Stack>
  )
}

function Shifts() {
  const { t } = useTranslation()
  const codes = useCodes()
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
          {t('attendance.shiftsHint')}
        </Text>
        {can('operator') && (
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() =>
              setEdit({
                name: '',
                startTime: '08:30',
                endTime: '17:30',
                breakMinutes: 60,
                toleranceMinutes: 10,
                weekdays: [true, true, true, true, true, false, false],
              })
            }
          >
            {t('attendance.newShift')}
          </Button>
        )}
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('attendance.colShiftName')}</Table.Th>
            <Table.Th>{t('attendance.colShiftHours')}</Table.Th>
            <Table.Th>{t('attendance.colBreak')}</Table.Th>
            <Table.Th>{t('attendance.colTolerance')}</Table.Th>
            <Table.Th>{t('common.days')}</Table.Th>
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
              <Table.Td>{t('common.minutes', { n: s.breakMinutes })}</Table.Td>
              <Table.Td>{t('common.minutes', { n: s.toleranceMinutes })}</Table.Td>
              <Table.Td>{codes.weekdaysText(s.weekdays)}</Table.Td>
              <Table.Td>
                {can('operator') && (
                  <Group gap={0} justify="flex-end">
                    <IconButton label={t('common.edit')} onClick={() => setEdit(s)}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton
                      label={t('common.delete')}
                      color="red"
                      onClick={() =>
                        void api
                          .del(`/shifts/${s.id}`)
                          .then(() => qc.invalidateQueries({ queryKey: ['shifts'] }))
                          .catch(notifyError)
                      }
                    >
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={!!edit} onClose={() => setEdit(null)} title={t('attendance.shiftTitle')}>
        {edit && (
          <Stack>
            <TextInput
              label={t('common.name')}
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.currentTarget.value })}
            />
            <SimpleGrid cols={2}>
              <TextInput
                label={t('attendance.shiftStart')}
                value={edit.startTime}
                onChange={(e) => setEdit({ ...edit, startTime: e.currentTarget.value })}
              />
              <TextInput
                label={t('attendance.shiftEnd')}
                value={edit.endTime}
                onChange={(e) => setEdit({ ...edit, endTime: e.currentTarget.value })}
              />
              <NumberInput
                label={t('attendance.shiftBreak')}
                min={0}
                value={edit.breakMinutes}
                onChange={(v) => setEdit({ ...edit, breakMinutes: Number(v) || 0 })}
              />
              <NumberInput
                label={t('attendance.shiftTolerance')}
                min={0}
                value={edit.toleranceMinutes}
                onChange={(v) => setEdit({ ...edit, toleranceMinutes: Number(v) || 0 })}
              />
            </SimpleGrid>
            <WeekdaysInput
              label={t('attendance.workingDays')}
              value={edit.weekdays}
              onChange={(w) => setEdit({ ...edit, weekdays: w })}
            />
            <Button onClick={() => void save()} disabled={!edit.name}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </Card>
  )
}

function Holidays() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = useAuth()
  const holidays = useQuery({
    queryKey: ['holidays'],
    queryFn: () => api.get<{ date: string; name: string }[]>('/holidays'),
  })
  const [date, setDate] = useState<string | null>(null)
  const [name, setName] = useState('')
  const year = new Date().getFullYear()
  const refresh = () => qc.invalidateQueries({ queryKey: ['holidays'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <Group align="flex-end" mb="md">
          <DateInput
            label={t('attendance.holidayDate')}
            valueFormat={DATE_INPUT_FORMAT}
            value={date}
            onChange={setDate}
          />
          <TextInput
            label={t('attendance.holidayName')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button
            disabled={!date || !name}
            onClick={() =>
              void api
                .post('/holidays', { date, name })
                .then(() => {
                  setName('')
                  void refresh()
                })
                .catch(notifyError)
            }
          >
            {t('common.add')}
          </Button>
          {[year, year + 1].map((y) => (
            <Button
              key={y}
              variant="default"
              leftSection={<IconCalendarPlus size={16} />}
              onClick={() =>
                void api
                  .post(`/holidays/italian/${y}${downloadQs({})}`)
                  .then(() => {
                    notifyOk(t('attendance.holidaysImported', { year: y }))
                    void refresh()
                  })
                  .catch(notifyError)
              }
            >
              {t('attendance.nationalHolidays', { year: y })}
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
                  <IconButton
                    label={t('common.delete')}
                    color="red"
                    onClick={() => void api.del(`/holidays/${h.date}`).then(refresh).catch(notifyError)}
                  >
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
  const { t } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const leaves = useQuery({
    queryKey: ['leaves'],
    queryFn: () =>
      api.get<{ id: number; personName: string; fromDate: string; toDate: string; type: string; notes: string }[]>(
        '/leaves',
      ),
  })
  const [form, setForm] = useState({
    personId: null as string | null,
    fromDate: today() as string | null,
    toDate: today() as string | null,
    type: 'ferie',
    notes: '',
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['leaves'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <SimpleGrid cols={{ base: 1, md: 6 }} mb="md">
          <Select
            label={t('attendance.person')}
            searchable
            data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))}
            value={form.personId}
            onChange={(v) => setForm({ ...form, personId: v })}
          />
          <DateInput
            label={t('common.from')}
            valueFormat={DATE_INPUT_FORMAT}
            value={form.fromDate}
            onChange={(v) => setForm({ ...form, fromDate: v })}
          />
          <DateInput
            label={t('common.to')}
            valueFormat={DATE_INPUT_FORMAT}
            value={form.toDate}
            onChange={(v) => setForm({ ...form, toDate: v })}
          />
          <Select
            label={t('attendance.leaveType')}
            data={LEAVE_TYPES.map((v) => ({ value: v, label: codes.leave(v) }))}
            value={form.type}
            onChange={(v) => setForm({ ...form, type: v ?? 'ferie' })}
          />
          <TextInput
            label={t('common.notes')}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
          />
          <Button
            mt={24}
            disabled={!form.personId || !form.fromDate || !form.toDate}
            onClick={() =>
              void api
                .post('/leaves', { ...form, personId: Number(form.personId) })
                .then(() => {
                  void refresh()
                })
                .catch(notifyError)
            }
          >
            {t('common.add')}
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
                <Badge variant="light">{codes.leave(l.type)}</Badge>
              </Table.Td>
              <Table.Td>{l.notes}</Table.Td>
              <Table.Td w={50}>
                {can('operator') && (
                  <IconButton
                    label={t('common.delete')}
                    color="red"
                    onClick={() => void api.del(`/leaves/${l.id}`).then(refresh).catch(notifyError)}
                  >
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
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { can } = useAuth()
  const people = usePeople()
  const [range] = useState({ from: addDays(today(), -31), to: today() })
  const punches = useQuery({
    queryKey: ['punches', range],
    queryFn: () =>
      api.get<
        {
          id: number
          personName: string
          timestamp: string
          direction: number
          reason: string
          operator: string | null
        }[]
      >(`/punches${qs(range)}`),
  })
  const [form, setForm] = useState({
    personId: null as string | null,
    date: today() as string | null,
    time: '08:30',
    direction: '1',
    reason: '',
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['punches'] })
  return (
    <Card withBorder>
      {can('operator') && (
        <SimpleGrid cols={{ base: 1, md: 6 }} mb="md">
          <Select
            label={t('attendance.person')}
            searchable
            data={(people.data ?? []).map((p) => ({ value: String(p.id), label: `${p.lastName} ${p.firstName}` }))}
            value={form.personId}
            onChange={(v) => setForm({ ...form, personId: v })}
          />
          <DateInput
            label={t('common.date')}
            valueFormat={DATE_INPUT_FORMAT}
            value={form.date}
            onChange={(v) => setForm({ ...form, date: v })}
          />
          <TextInput
            label={t('common.time')}
            value={form.time}
            onChange={(e) => setForm({ ...form, time: e.currentTarget.value })}
          />
          <Select
            label={t('attendance.punchDirection')}
            data={[
              { value: '1', label: t('attendance.in') },
              { value: '2', label: t('attendance.out') },
            ]}
            value={form.direction}
            onChange={(v) => setForm({ ...form, direction: v ?? '1' })}
          />
          <TextInput
            label={t('attendance.punchReason')}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })}
          />
          <Button
            mt={24}
            disabled={!form.personId || !form.date || !form.reason}
            onClick={() =>
              void api
                .post('/punches', {
                  personId: Number(form.personId),
                  timestamp: `${form.date} ${form.time}`,
                  direction: Number(form.direction),
                  reason: form.reason,
                })
                .then(() => {
                  setForm({ ...form, reason: '' })
                  void refresh()
                })
                .catch(notifyError)
            }
          >
            {t('common.add')}
          </Button>
        </SimpleGrid>
      )}
      <Table>
        <Table.Tbody>
          {(punches.data ?? []).map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>{p.personName}</Table.Td>
              <Table.Td className="mono">{fmtDateTime(p.timestamp)}</Table.Td>
              <Table.Td>{p.direction === 1 ? t('attendance.in') : t('attendance.out')}</Table.Td>
              <Table.Td>{p.reason}</Table.Td>
              <Table.Td c="dimmed">{p.operator}</Table.Td>
              <Table.Td w={50}>
                {can('operator') && (
                  <IconButton
                    label={t('common.delete')}
                    color="red"
                    onClick={() => void api.del(`/punches/${p.id}`).then(refresh).catch(notifyError)}
                  >
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
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('attendance.title')} description={t('attendance.description')} />
      <Tabs defaultValue="report" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="report">{t('attendance.tabReport')}</Tabs.Tab>
          <Tabs.Tab value="shifts">{t('attendance.tabShifts')}</Tabs.Tab>
          <Tabs.Tab value="holidays">{t('attendance.tabHolidays')}</Tabs.Tab>
          <Tabs.Tab value="leaves">{t('attendance.tabLeaves')}</Tabs.Tab>
          <Tabs.Tab value="punches">{t('attendance.tabPunches')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="report">
          <Report />
        </Tabs.Panel>
        <Tabs.Panel value="shifts">
          <Shifts />
        </Tabs.Panel>
        <Tabs.Panel value="holidays">
          <Holidays />
        </Tabs.Panel>
        <Tabs.Panel value="leaves">
          <Leaves />
        </Tabs.Panel>
        <Tabs.Panel value="punches">
          <ManualPunches />
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
