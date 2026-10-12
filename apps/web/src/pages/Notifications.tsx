import { Badge, Button, Card, Checkbox, Group, Modal, MultiSelect, NumberInput, PasswordInput, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconBell, IconEdit, IconPlus, IconReportAnalytics, IconSend, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Language, NotificationChannelDto, NotificationConfig, NotificationType, WebhookEvent } from '@uhppote-desk/shared'
import { LANGUAGES, NOTIFICATION_TYPES, SECRET_MASK, WEBHOOK_EVENTS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useDoors } from '../lib/queries'

interface Form {
  id?: number
  name: string
  enabled: boolean
  events: WebhookEvent[]
  doorIds: string[]
  language: Language
  dailyReport: boolean
  reportHour: number
  config: NotificationConfig
}

const DEFAULTS: { [K in NotificationType]: Extract<NotificationConfig, { type: K }> } = {
  telegram: { type: 'telegram', botToken: '', chatId: '', openButton: false, allowedUserIds: [] },
  email: { type: 'email', host: '', port: 587, secure: false, username: '', password: '', from: '', to: [] },
  ntfy: { type: 'ntfy', serverUrl: 'https://ntfy.sh', topic: '', token: '', username: '', password: '' },
  gotify: { type: 'gotify', serverUrl: '', appToken: '' },
}

const list = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export function NotificationsPage() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const doors = useDoors()
  const channels = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<NotificationChannelDto[]>('/notifications') })
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const eventLabel = (e: string) => t(`codes.webhookEvent.${e.replace('.', '_')}` as 'codes.webhookEvent.alarm', { defaultValue: e })
  const typeLabel = (type: NotificationType) => t(`codes.notificationType.${type}`)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notifications'] })

  const save = async () => {
    if (!form) return
    try {
      const { id, doorIds, ...rest } = form
      const body = { ...rest, doorIds: doorIds.map(Number) }
      if (id) await api.put(`/notifications/${id}`, body)
      else await api.post('/notifications', body)
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const run = async (c: NotificationChannelDto, what: 'test' | 'report') => {
    setBusy(`${what}${c.id}`)
    try {
      const r = await api.post<{ ok: boolean; error: string | null }>(`/notifications/${c.id}/${what}`)
      if (r.ok) notifyOk(t(what === 'test' ? 'notifications.testOk' : 'notifications.reportOk'))
      else notifyError(new Error(t('notifications.sendFailed', { error: r.error ?? '?' })))
      refresh()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(null)
    }
  }

  const remove = (c: NotificationChannelDto) =>
    modals.openConfirmModal({
      title: t('notifications.deleteTitle', { name: c.name }),
      children: <Text size="sm">{t('notifications.deleteInfo')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => api.del(`/notifications/${c.id}`).then(refresh).catch(notifyError),
    })

  const newForm = (): Form => ({
    name: '',
    enabled: true,
    events: ['access.denied', 'alarm', 'controller.offline'],
    doorIds: [],
    language: (LANGUAGES.find((l) => i18n.language.startsWith(l.code))?.code ?? 'en') as Language,
    dailyReport: false,
    reportHour: 20,
    config: DEFAULTS.telegram,
  })

  const setConfig = (patch: Partial<Record<string, unknown>>) => form && setForm({ ...form, config: { ...form.config, ...patch } as NotificationConfig })
  const secretHint = (v: string) => (v === SECRET_MASK ? t('notifications.secretKept') : undefined)

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        description={t('notifications.description')}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setForm(newForm())}>
            {t('notifications.new')}
          </Button>
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('notifications.colName')}</Table.Th>
              <Table.Th>{t('notifications.colType')}</Table.Th>
              <Table.Th>{t('notifications.colEvents')}</Table.Th>
              <Table.Th>{t('notifications.colReport')}</Table.Th>
              <Table.Th>{t('notifications.colLastSent')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(channels.data ?? []).map((c) => (
              <Table.Tr key={c.id} opacity={c.enabled ? 1 : 0.5}>
                <Table.Td>{c.name}</Table.Td>
                <Table.Td>
                  <Badge variant="light">{typeLabel(c.config.type)}</Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {c.events.map((e) => (
                      <Badge key={e} variant="outline" size="sm">
                        {eventLabel(e)}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{c.dailyReport ? t('notifications.reportAt', { hour: String(c.reportHour).padStart(2, '0') }) : '—'}</Table.Td>
                <Table.Td>
                  {c.lastSentAt ? (
                    <Stack gap={2} align="flex-start">
                      <Tooltip label={c.lastError ?? 'OK'} multiline maw={360}>
                        <Badge color={c.lastError ? 'red' : 'green'} variant="light">
                          {c.lastError ? t('common.error') : t('common.ok')}
                        </Badge>
                      </Tooltip>
                      <Text size="xs" c="dimmed">
                        {fmtDateTime(c.lastSentAt)}
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t('notifications.never')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end" wrap="nowrap">
                    <IconButton label={t('notifications.test')} onClick={() => void run(c, 'test')} loading={busy === `test${c.id}`}>
                      <IconSend size={16} />
                    </IconButton>
                    {c.dailyReport && (
                      <IconButton label={t('notifications.sendReport')} onClick={() => void run(c, 'report')} loading={busy === `report${c.id}`}>
                        <IconReportAnalytics size={16} />
                      </IconButton>
                    )}
                    <IconButton label={t('common.edit')} onClick={() => setForm({ ...c, doorIds: c.doorIds.map(String) })}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label={t('common.delete')} color="red" onClick={() => remove(c)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Text size="xs" c="dimmed" mt="xs">
        {t('notifications.docs')}
      </Text>

      <Modal opened={!!form} onClose={() => setForm(null)} title={form?.id ? t('notifications.editTitle') : t('notifications.newTitle')} size="lg">
        {form && (
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label={t('notifications.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
              <Select
                label={t('notifications.type')}
                data={NOTIFICATION_TYPES.map((x) => ({ value: x, label: typeLabel(x) }))}
                value={form.config.type}
                allowDeselect={false}
                onChange={(v) => v && v !== form.config.type && setForm({ ...form, config: DEFAULTS[v as NotificationType] })}
              />
            </SimpleGrid>

            {form.config.type === 'telegram' && (
              <>
                <PasswordInput
                  label={t('notifications.tgBotToken')}
                  description={secretHint(form.config.botToken) ?? t('notifications.tgBotTokenHint')}
                  value={form.config.botToken}
                  onChange={(e) => setConfig({ botToken: e.currentTarget.value })}
                />
                <TextInput label={t('notifications.tgChatId')} description={t('notifications.tgChatIdHint')} value={form.config.chatId} onChange={(e) => setConfig({ chatId: e.currentTarget.value })} />
                <Switch
                  label={t('notifications.tgOpenButton')}
                  description={t('notifications.tgOpenButtonHint')}
                  checked={form.config.openButton}
                  onChange={(e) => setConfig({ openButton: e.currentTarget.checked })}
                />
                {form.config.openButton && (
                  <TextInput
                    label={t('notifications.tgUsers')}
                    description={t('notifications.tgUsersHint')}
                    defaultValue={form.config.allowedUserIds.join(', ')}
                    onChange={(e) => setConfig({ allowedUserIds: list(e.currentTarget.value).map(Number).filter((n) => Number.isInteger(n) && n > 0) })}
                  />
                )}
              </>
            )}

            {form.config.type === 'email' && (
              <>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput label={t('notifications.mailHost')} value={form.config.host} onChange={(e) => setConfig({ host: e.currentTarget.value })} />
                  <NumberInput label={t('notifications.mailPort')} min={1} max={65535} value={form.config.port} onChange={(v) => setConfig({ port: Number(v) || 587 })} />
                  <TextInput label={t('notifications.mailUsername')} value={form.config.username} onChange={(e) => setConfig({ username: e.currentTarget.value })} />
                  <PasswordInput
                    label={t('notifications.mailPassword')}
                    description={secretHint(form.config.password)}
                    value={form.config.password}
                    onChange={(e) => setConfig({ password: e.currentTarget.value })}
                  />
                </SimpleGrid>
                <Switch
                  label={t('notifications.mailSecure')}
                  description={t('notifications.mailSecureHint')}
                  checked={form.config.secure}
                  onChange={(e) => setConfig({ secure: e.currentTarget.checked })}
                />
                <TextInput label={t('notifications.mailFrom')} value={form.config.from} onChange={(e) => setConfig({ from: e.currentTarget.value })} />
                <TextInput
                  label={t('notifications.mailTo')}
                  description={t('notifications.mailToHint')}
                  defaultValue={form.config.to.join(', ')}
                  onChange={(e) => setConfig({ to: list(e.currentTarget.value) })}
                />
              </>
            )}

            {form.config.type === 'ntfy' && (
              <>
                <TextInput label={t('notifications.ntfyServer')} description={t('notifications.ntfyServerHint')} value={form.config.serverUrl} onChange={(e) => setConfig({ serverUrl: e.currentTarget.value })} />
                <TextInput label={t('notifications.ntfyTopic')} value={form.config.topic} onChange={(e) => setConfig({ topic: e.currentTarget.value })} />
                <PasswordInput
                  label={t('notifications.ntfyToken')}
                  description={secretHint(form.config.token) ?? t('notifications.ntfyTokenHint')}
                  value={form.config.token}
                  onChange={(e) => setConfig({ token: e.currentTarget.value })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput label={t('notifications.ntfyUsername')} value={form.config.username} onChange={(e) => setConfig({ username: e.currentTarget.value })} />
                  <PasswordInput
                    label={t('notifications.ntfyPassword')}
                    description={secretHint(form.config.password)}
                    value={form.config.password}
                    onChange={(e) => setConfig({ password: e.currentTarget.value })}
                  />
                </SimpleGrid>
              </>
            )}

            {form.config.type === 'gotify' && (
              <>
                <TextInput label={t('notifications.gotifyServer')} description={t('notifications.gotifyServerHint')} value={form.config.serverUrl} onChange={(e) => setConfig({ serverUrl: e.currentTarget.value })} />
                <PasswordInput
                  label={t('notifications.gotifyToken')}
                  description={secretHint(form.config.appToken) ?? t('notifications.gotifyTokenHint')}
                  value={form.config.appToken}
                  onChange={(e) => setConfig({ appToken: e.currentTarget.value })}
                />
              </>
            )}

            <Checkbox.Group label={t('notifications.events')} description={t('notifications.eventsHint')} value={form.events} onChange={(v) => setForm({ ...form, events: v as WebhookEvent[] })}>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6} mt={6}>
                {WEBHOOK_EVENTS.map((e) => (
                  <Checkbox key={e} value={e} label={eventLabel(e)} />
                ))}
              </SimpleGrid>
            </Checkbox.Group>
            <MultiSelect
              label={t('notifications.doors')}
              description={t('notifications.doorsHint')}
              placeholder={form.doorIds.length ? undefined : t('notifications.allDoors')}
              data={(doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
              value={form.doorIds}
              onChange={(v) => setForm({ ...form, doorIds: v })}
              searchable
            />
            <Group align="flex-end" wrap="nowrap">
              <Switch
                style={{ flex: 1 }}
                label={t('notifications.dailyReport')}
                description={t('notifications.dailyReportHint')}
                checked={form.dailyReport}
                onChange={(e) => setForm({ ...form, dailyReport: e.currentTarget.checked })}
              />
              <Select
                w={110}
                label={t('notifications.reportHour')}
                disabled={!form.dailyReport}
                data={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))}
                value={String(form.reportHour)}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, reportHour: Number(v ?? 20) })}
              />
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('notifications.language')}
                data={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                value={form.language}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, language: (v ?? 'en') as Language })}
              />
              <Switch mt="xl" label={t('notifications.enabledSwitch')} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })} />
            </SimpleGrid>
            <Button leftSection={<IconBell size={16} />} onClick={() => void save()} disabled={!form.name.trim() || (form.events.length === 0 && !form.dailyReport)}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
