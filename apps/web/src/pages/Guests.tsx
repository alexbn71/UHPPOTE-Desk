import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { DateTimePicker, TimeInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import {
  IconBrandWhatsapp,
  IconCopy,
  IconDeviceMobileOff,
  IconEdit,
  IconHistory,
  IconLink,
  IconPlus,
  IconShare,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GuestLinkDto, GuestOpenDto, GuestPassDto, GuestStatus, MobileDoorDto } from '@uhppote-desk/shared'
import { MIN_PLATE_LENGTH, normalizePlate } from '@uhppote-desk/shared'
import { IconButton, PageHeader, WeekdaysInput } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useCodes } from '../lib/codes'
import { addDays, fmtDateTime, fmtDateTimeShort, today } from '../lib/format'

interface Form {
  id?: number
  name: string
  note: string
  doorIds: string[]
  validFrom: string
  validTo: string
  repeat: boolean
  weekdays: boolean[]
  timeFrom: string
  timeTo: string
  maxOpens: number | ''
  bindDevice: boolean
  pinOn: boolean
  pin: string
  /** Editing a pass that already has a PIN: an empty field keeps it. */
  hadPin: boolean
  plates: string[]
}

/** The link just created, to send to the guest. */
interface Share {
  link: GuestLinkDto
  /** The PIN typed in the form (known only right after saving it). */
  pin: string | null
}

const ALL_DAYS = [true, true, true, true, true, true, true]

const STATUS_COLOR: Record<GuestStatus, string> = {
  active: 'green',
  notYet: 'blue',
  outsideHours: 'yellow',
  expired: 'gray',
  used: 'gray',
  locked: 'red',
  revoked: 'gray',
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Now, 'YYYY-MM-DD HH:mm'. */
function nowMinute(): string {
  const d = new Date()
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0')

const emptyForm = (): Form => ({
  name: '',
  note: '',
  doorIds: [],
  validFrom: nowMinute(),
  validTo: `${today()} 23:59`,
  repeat: false,
  weekdays: ALL_DAYS,
  timeFrom: '',
  timeTo: '',
  maxOpens: '',
  bindDevice: true,
  pinOn: false,
  pin: '',
  hadPin: false,
  plates: [],
})

const formOf = (p: GuestPassDto): Form => ({
  id: p.id,
  name: p.name,
  note: p.note,
  doorIds: p.doorIds.map(String),
  validFrom: p.validFrom,
  validTo: p.validTo,
  repeat: p.weekdays.some((d) => !d) || p.timeFrom !== null,
  weekdays: p.weekdays,
  timeFrom: p.timeFrom ?? '',
  timeTo: p.timeTo ?? '',
  maxOpens: p.maxOpens ?? '',
  bindDevice: p.bindDevice,
  pinOn: p.hasPin,
  pin: '',
  hadPin: p.hasPin,
  plates: p.plates,
})

/** Guest passes: links that open some doors for a while, without card or app. */
export function GuestsPage() {
  const { t } = useTranslation()
  const codes = useCodes()
  const qc = useQueryClient()
  const passes = useQuery({ queryKey: ['guests'], queryFn: () => api.get<GuestPassDto[]>('/guests') })
  // the doors this operator may open (role, zones): the only ones a pass can have
  const doors = useQuery({ queryKey: ['mobile-doors'], queryFn: () => api.get<MobileDoorDto[]>('/mobile/doors') })
  const [form, setForm] = useState<Form | null>(null)
  const [share, setShare] = useState<Share | null>(null)
  const [history, setHistory] = useState<GuestPassDto | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  const refresh = () => void qc.invalidateQueries({ queryKey: ['guests'] })
  const doorName = (id: number) => doors.data?.find((d) => d.id === id)?.name ?? `#${id}`
  const inactive = (p: GuestPassDto) => ['expired', 'used', 'revoked'].includes(p.status)
  const visible = (passes.data ?? []).filter((p) => showInactive || !inactive(p))

  const pinValid = !form?.pinOn || /^\d{4,8}$/.test(form.pin) || (form.hadPin && form.pin === '')
  const canSave =
    !!form &&
    form.name.trim() !== '' &&
    form.doorIds.length > 0 &&
    form.validFrom < form.validTo &&
    (!form.repeat || (form.timeFrom === '') === (form.timeTo === '')) &&
    pinValid

  const save = async () => {
    if (!form) return
    try {
      const body = {
        name: form.name,
        note: form.note,
        doorIds: form.doorIds.map(Number),
        validFrom: form.validFrom,
        validTo: form.validTo,
        weekdays: form.repeat ? form.weekdays : ALL_DAYS,
        timeFrom: form.repeat && form.timeFrom ? form.timeFrom : null,
        timeTo: form.repeat && form.timeTo ? form.timeTo : null,
        maxOpens: form.maxOpens === '' ? null : form.maxOpens,
        bindDevice: form.bindDevice,
        plates: form.plates,
        // PIN: null = none; omitted = keep the current one
        ...(!form.pinOn ? { pin: null } : form.pin ? { pin: form.pin } : {}),
      }
      if (form.id) await api.put(`/guests/${form.id}`, body)
      else {
        const link = await api.post<GuestLinkDto>('/guests', body)
        setShare({ link, pin: form.pinOn ? form.pin : null })
      }
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const confirm = (title: string, text: string, label: string, run: () => Promise<unknown>, color = 'red') =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{text}</Text>,
      labels: { confirm: label, cancel: t('common.cancel') },
      confirmProps: { color },
      onConfirm: () => void run().then(refresh).catch(notifyError),
    })

  const newLink = (p: GuestPassDto) =>
    confirm(
      t('guests.newLink'),
      t('guests.newLinkConfirm', { name: p.name }),
      t('guests.newLink'),
      async () => setShare({ link: await api.post<GuestLinkDto>(`/guests/${p.id}/link`), pin: null }),
      'blue',
    )

  const unbind = (p: GuestPassDto) =>
    api
      .post(`/guests/${p.id}/unbind`)
      .then(() => {
        notifyOk(t('guests.unbindDone'))
        refresh()
      })
      .catch(notifyError)

  const validity = (p: Pick<GuestPassDto, 'validFrom' | 'validTo' | 'weekdays' | 'timeFrom' | 'timeTo'>) => {
    const range = `${fmtDateTimeShort(p.validFrom)} → ${fmtDateTimeShort(p.validTo)}`
    if (p.timeFrom && p.timeTo)
      return [
        range,
        t('guests.validityRepeat', { days: codes.weekdaysText(p.weekdays), from: p.timeFrom, to: p.timeTo }),
      ]
    if (p.weekdays.some((d) => !d)) return [range, codes.weekdaysText(p.weekdays)]
    return [range]
  }

  const preset = (days: number, startTomorrow = false) => {
    if (!form) return
    const from = startTomorrow ? `${addDays(today(), 1)} 00:00` : nowMinute()
    setForm({ ...form, validFrom: from, validTo: `${addDays(from.slice(0, 10), days)} 23:59` })
  }

  return (
    <>
      <PageHeader
        title={t('guests.title')}
        description={t('guests.description')}
        actions={
          <>
            <Switch
              label={t('guests.showInactive')}
              checked={showInactive}
              onChange={(e) => setShowInactive(e.currentTarget.checked)}
            />
            <Button leftSection={<IconPlus size={16} />} onClick={() => setForm(emptyForm())}>
              {t('guests.new')}
            </Button>
          </>
        }
      />
      <Card withBorder>
        <Table.ScrollContainer minWidth={900}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('guests.colName')}</Table.Th>
                <Table.Th>{t('guests.colDoors')}</Table.Th>
                <Table.Th>{t('guests.colValidity')}</Table.Th>
                <Table.Th>{t('guests.colStatus')}</Table.Th>
                <Table.Th>{t('guests.colOpens')}</Table.Th>
                <Table.Th>{t('guests.colDevice')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed" size="sm">
                      {t('guests.empty')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {visible.map((p) => (
                <Table.Tr key={p.id} opacity={inactive(p) ? 0.5 : 1}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {p.name}
                    </Text>
                    {p.note && (
                      <Text size="xs" c="dimmed">
                        {p.note}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {p.doorIds.map(doorName).join(', ')}
                    {p.plates.length > 0 && (
                      <Text size="xs" c="dimmed" className="mono">
                        {p.plates.join(' · ')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {validity(p).map((line) => (
                      <Text key={line} size="sm">
                        {line}
                      </Text>
                    ))}
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <Badge variant="light" color={STATUS_COLOR[p.status]} style={{ overflow: 'visible' }}>
                      {t(`codes.guestStatus.${p.status}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {p.maxOpens === null ? p.opens : t('guests.opensValue', { n: p.opens, max: p.maxOpens })}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {!p.bindDevice
                        ? t('guests.deviceAny')
                        : p.boundAt
                          ? t('guests.deviceBound', { date: fmtDateTimeShort(p.boundAt) })
                          : t('guests.deviceFree')}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={0} justify="flex-end" wrap="nowrap">
                      <IconButton label={t('common.edit')} onClick={() => setForm(formOf(p))}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label={t('guests.history')} onClick={() => setHistory(p)}>
                        <IconHistory size={16} />
                      </IconButton>
                      {p.status !== 'revoked' && (
                        <IconButton label={t('guests.newLink')} onClick={() => newLink(p)}>
                          <IconLink size={16} />
                        </IconButton>
                      )}
                      {(p.boundAt || p.locked) && p.status !== 'revoked' && (
                        <IconButton
                          label={p.locked ? t('guests.unlock') : t('guests.unbind')}
                          onClick={() => unbind(p)}
                        >
                          <IconDeviceMobileOff size={16} />
                        </IconButton>
                      )}
                      {p.status !== 'revoked' && (
                        <IconButton
                          label={t('guests.revoke')}
                          color="orange"
                          onClick={() =>
                            confirm(
                              t('guests.revoke'),
                              t('guests.revokeConfirm', { name: p.name }),
                              t('guests.revoke'),
                              () => api.post(`/guests/${p.id}/revoke`),
                            )
                          }
                        >
                          <IconX size={16} />
                        </IconButton>
                      )}
                      <IconButton
                        label={t('common.delete')}
                        color="red"
                        onClick={() =>
                          confirm(
                            t('guests.deleteTitle', { name: p.name }),
                            t('guests.deleteInfo'),
                            t('common.delete'),
                            () => api.del(`/guests/${p.id}`),
                          )
                        }
                      >
                        <IconTrash size={16} />
                      </IconButton>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Text size="xs" c="dimmed" mt="xs">
        {t('guests.docs')}
      </Text>

      <Modal
        opened={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t('guests.editTitle') : t('guests.newTitle')}
        size="lg"
      >
        {form && (
          <Stack>
            <TextInput
              label={t('guests.name')}
              description={t('guests.nameHint')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
              data-autofocus
            />
            <Textarea
              label={t('guests.note')}
              description={t('guests.noteHint')}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.currentTarget.value })}
              autosize
              minRows={1}
            />
            <MultiSelect
              label={t('guests.doors')}
              description={t('guests.doorsHint')}
              data={(doors.data ?? [])
                .filter((d) => d.canOpen)
                .map((d) => ({ value: String(d.id), label: `${d.name} (${d.controllerName})` }))}
              value={form.doorIds}
              onChange={(v) => setForm({ ...form, doorIds: v })}
              searchable
            />
            <Group gap="xs">
              <Button size="xs" variant="light" onClick={() => preset(0)}>
                {t('guests.presetToday')}
              </Button>
              <Button size="xs" variant="light" onClick={() => preset(0, true)}>
                {t('guests.presetTomorrow')}
              </Button>
              <Button size="xs" variant="light" onClick={() => preset(7)}>
                {t('guests.preset7')}
              </Button>
              <Button size="xs" variant="light" onClick={() => preset(30)}>
                {t('guests.preset30')}
              </Button>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <DateTimePicker
                label={t('guests.validFrom')}
                valueFormat="L HH:mm"
                value={form.validFrom}
                onChange={(v) => v && setForm({ ...form, validFrom: String(v).slice(0, 16) })}
              />
              <DateTimePicker
                label={t('guests.validTo')}
                valueFormat="L HH:mm"
                value={form.validTo}
                onChange={(v) => v && setForm({ ...form, validTo: String(v).slice(0, 16) })}
                error={form.validFrom >= form.validTo ? t('errors.dateOrder') : undefined}
              />
            </SimpleGrid>
            <Switch
              label={t('guests.repeat')}
              description={t('guests.repeatHint')}
              checked={form.repeat}
              onChange={(e) => setForm({ ...form, repeat: e.currentTarget.checked })}
            />
            {form.repeat && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <WeekdaysInput
                  label={t('guests.weekdays')}
                  value={form.weekdays}
                  onChange={(w) => setForm({ ...form, weekdays: w })}
                />
                <Group grow align="flex-start">
                  <TimeInput
                    label={t('guests.timeFrom')}
                    value={form.timeFrom}
                    onChange={(e) => setForm({ ...form, timeFrom: e.currentTarget.value })}
                  />
                  <TimeInput
                    label={t('guests.timeTo')}
                    value={form.timeTo}
                    onChange={(e) => setForm({ ...form, timeTo: e.currentTarget.value })}
                  />
                </Group>
              </SimpleGrid>
            )}
            <TagsInput
              label={t('guests.plates')}
              description={t('guests.platesHint')}
              placeholder={t('plates.platePlaceholder')}
              value={form.plates}
              onChange={(v) =>
                setForm({
                  ...form,
                  plates: [...new Set(v.map(normalizePlate).filter((x) => x.length >= MIN_PLATE_LENGTH))],
                })
              }
              maxTags={5}
              splitChars={[',', ';']}
              styles={{ pill: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
            <NumberInput
              label={t('guests.maxOpens')}
              description={t('guests.maxOpensHint')}
              min={1}
              max={10000}
              allowDecimal={false}
              value={form.maxOpens}
              onChange={(v) => setForm({ ...form, maxOpens: typeof v === 'number' ? v : '' })}
            />
            <Switch
              label={t('guests.bindDevice')}
              description={t('guests.bindDeviceHint')}
              checked={form.bindDevice}
              onChange={(e) => setForm({ ...form, bindDevice: e.currentTarget.checked })}
            />
            <Switch
              label={t('guests.pinSwitch')}
              checked={form.pinOn}
              onChange={(e) =>
                setForm({
                  ...form,
                  pinOn: e.currentTarget.checked,
                  pin: e.currentTarget.checked && !form.hadPin ? randomPin() : '',
                })
              }
            />
            {form.pinOn && (
              <Group align="flex-end" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  label={t('guests.pin')}
                  description={form.hadPin ? t('guests.pinKeep') : t('guests.pinHint')}
                  inputMode="numeric"
                  maxLength={8}
                  value={form.pin}
                  onChange={(e) => setForm({ ...form, pin: e.currentTarget.value.replace(/\D/g, '') })}
                  error={!pinValid}
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                />
                <Button variant="default" onClick={() => setForm({ ...form, pin: randomPin() })}>
                  {t('guests.pinGenerate')}
                </Button>
              </Group>
            )}
            <Button onClick={() => void save()} disabled={!canSave}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>

      <ShareModal share={share} onClose={() => setShare(null)} doorName={doorName} validity={validity} />
      <HistoryModal pass={history} onClose={() => setHistory(null)} />
    </>
  )
}

function ShareModal({
  share,
  onClose,
  doorName,
  validity,
}: {
  share: Share | null
  onClose: () => void
  doorName: (id: number) => string
  validity: (p: GuestPassDto) => string[]
}) {
  const { t } = useTranslation()
  const p = share?.link.pass
  const range = p
    ? t('guests.shareValidity', { from: fmtDateTimeShort(p.validFrom), to: fmtDateTimeShort(p.validTo) })
    : ''
  const extra = p ? validity(p).slice(1) : []
  const message =
    p && share
      ? t('guests.shareText', {
          name: p.name,
          doors: p.doorIds.map(doorName).join(', '),
          link: share.link.link,
          validity: extra.length ? `${range} (${extra.join(', ')})` : range,
        })
      : ''
  const canShare = typeof navigator.share === 'function'

  return (
    <Modal opened={!!share} onClose={onClose} title={p ? t('guests.shareTitle', { name: p.name }) : ''} size="lg">
      {share && p && (
        <Stack>
          <Text size="sm">{t('guests.shareInfo')}</Text>
          <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {message}
          </Code>
          {p.hasPin && (
            <Alert color="orange">
              {share.pin ? t('guests.pinReminder', { pin: share.pin }) : t('guests.pinReminderUnknown')}
            </Alert>
          )}
          <Group gap="xs">
            {canShare && (
              <Button
                leftSection={<IconShare size={16} />}
                onClick={() => void navigator.share({ text: message }).catch(() => undefined)}
              >
                {t('guests.share')}
              </Button>
            )}
            <Button
              component="a"
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
              color="green"
              leftSection={<IconBrandWhatsapp size={16} />}
            >
              {t('guests.whatsapp')}
            </Button>
            <CopyButton value={message}>
              {({ copied, copy }) => (
                <Button
                  variant="light"
                  color={copied ? 'green' : 'blue'}
                  leftSection={<IconCopy size={16} />}
                  onClick={copy}
                >
                  {copied ? t('guests.copied') : t('guests.copyMessage')}
                </Button>
              )}
            </CopyButton>
            <CopyButton value={share.link.link}>
              {({ copied, copy }) => (
                <Button
                  variant="light"
                  color={copied ? 'green' : 'blue'}
                  leftSection={<IconLink size={16} />}
                  onClick={copy}
                >
                  {copied ? t('guests.copied') : t('guests.copyLink')}
                </Button>
              )}
            </CopyButton>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}

function HistoryModal({ pass, onClose }: { pass: GuestPassDto | null; onClose: () => void }) {
  const { t } = useTranslation()
  const opens = useQuery({
    queryKey: ['guest-opens', pass?.id],
    queryFn: () => api.get<GuestOpenDto[]>(`/guests/${pass!.id}/opens`),
    enabled: !!pass,
  })
  return (
    <Modal
      opened={!!pass}
      onClose={onClose}
      title={pass ? t('guests.historyTitle', { name: pass.name }) : ''}
      size="lg"
    >
      {opens.data?.length === 0 ? (
        <Text c="dimmed" size="sm">
          {t('guests.noHistory')}
        </Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('guests.colAt')}</Table.Th>
              <Table.Th>{t('guests.colDoor')}</Table.Th>
              <Table.Th>{t('guests.colOutcome')}</Table.Th>
              <Table.Th>{t('guests.colIp')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(opens.data ?? []).map((o) => (
              <Table.Tr key={o.id}>
                <Table.Td>{fmtDateTime(o.at)}</Table.Td>
                <Table.Td>{o.doorName ?? '—'}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={o.outcome === 'ok' ? 'green' : 'red'}>
                    {t(`codes.guestOutcome.${o.outcome}`)}
                  </Badge>
                </Table.Td>
                <Table.Td className="mono">{o.ip ?? '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  )
}
