import { Alert, Badge, Button, Card, Checkbox, Code, CopyButton, Group, Modal, MultiSelect, Stack, Switch, Table, Text, Textarea, TextInput, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconCopy, IconEdit, IconList, IconPlus, IconRefresh, IconSend, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebhookDeliveryDto, WebhookDto, WebhookEvent } from '@uhppote-desk/shared'
import { WEBHOOK_EVENTS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { fmtDateTime } from '../lib/format'
import { useDoors } from '../lib/queries'

interface Form {
  id?: number
  name: string
  url: string
  enabled: boolean
  events: WebhookEvent[]
  doorIds: string[]
  headers: string
  secret?: string
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/

/** "Name: value" lines → object; returns the first invalid line instead. */
function parseHeaders(text: string): Record<string, string> | { invalid: string } {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const i = line.indexOf(':')
    const name = i > 0 ? line.slice(0, i).trim() : ''
    if (!HEADER_NAME.test(name)) return { invalid: line }
    out[name] = line.slice(i + 1).trim()
  }
  return out
}

const headersText = (h: Record<string, string>) =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

export function WebhooksPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const doors = useDoors()
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<WebhookDto[]>('/webhooks') })
  const [form, setForm] = useState<Form | null>(null)
  const [log, setLog] = useState<WebhookDto | null>(null)
  const [testing, setTesting] = useState<number | null>(null)

  const eventLabel = (e: string) => t(`codes.webhookEvent.${e.replace('.', '_')}` as 'codes.webhookEvent.alarm', { defaultValue: e })
  const doorName = (id: number) => doors.data?.find((d) => d.id === id)?.name ?? `#${id}`
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] })

  const headers = form ? parseHeaders(form.headers) : {}
  const headersError = 'invalid' in headers ? t('webhooks.headersInvalid', { line: headers.invalid }) : null

  const save = async () => {
    if (!form || 'invalid' in headers) return
    try {
      const body = { name: form.name, url: form.url, enabled: form.enabled, events: form.events, doorIds: form.doorIds.map(Number), headers }
      if (form.id) await api.put(`/webhooks/${form.id}`, body)
      else await api.post('/webhooks', body)
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const test = async (w: WebhookDto) => {
    setTesting(w.id)
    try {
      const r = await api.post<WebhookDeliveryDto | null>(`/webhooks/${w.id}/test`)
      if (r?.ok) notifyOk(t('webhooks.testOk', { status: r.statusCode ?? '', ms: r.durationMs }))
      else notifyError(new Error(t('webhooks.testFailed', { error: r?.error ?? '?' })))
      refresh()
    } catch (err) {
      notifyError(err)
    } finally {
      setTesting(null)
    }
  }

  const regenerate = (id: number, name: string) =>
    modals.openConfirmModal({
      title: t('webhooks.regenerateTitle', { name }),
      children: <Text size="sm">{t('webhooks.regenerateInfo')}</Text>,
      labels: { confirm: t('webhooks.regenerate'), cancel: t('common.cancel') },
      onConfirm: () =>
        api
          .post<WebhookDto>(`/webhooks/${id}/secret`)
          .then((w) => {
            setForm((f) => (f && f.id === id ? { ...f, secret: w.secret } : f))
            refresh()
          })
          .catch(notifyError),
    })

  const remove = (w: WebhookDto) =>
    modals.openConfirmModal({
      title: t('webhooks.deleteTitle', { name: w.name }),
      children: <Text size="sm">{t('webhooks.deleteInfo')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => api.del(`/webhooks/${w.id}`).then(refresh).catch(notifyError),
    })

  return (
    <>
      <PageHeader
        title={t('webhooks.title')}
        description={t('webhooks.description')}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ name: '', url: 'https://', enabled: true, events: ['access.granted', 'access.denied'], doorIds: [], headers: '' })}>
            {t('webhooks.new')}
          </Button>
        }
      />
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('webhooks.colName')}</Table.Th>
              <Table.Th>{t('webhooks.colUrl')}</Table.Th>
              <Table.Th>{t('webhooks.colEvents')}</Table.Th>
              <Table.Th>{t('webhooks.colDoors')}</Table.Th>
              <Table.Th>{t('webhooks.colLastDelivery')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(webhooks.data ?? []).map((w) => (
              <Table.Tr key={w.id} opacity={w.enabled ? 1 : 0.5}>
                <Table.Td>{w.name}</Table.Td>
                <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                  {w.url}
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {w.events.map((e) => (
                      <Badge key={e} variant="light" size="sm">
                        {eventLabel(e)}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{w.doorIds.length ? w.doorIds.map(doorName).join(', ') : t('webhooks.allDoors')}</Table.Td>
                <Table.Td>
                  {w.lastDelivery ? (
                    <Stack gap={2} align="flex-start">
                      <Tooltip label={w.lastDelivery.error ?? `HTTP ${w.lastDelivery.statusCode}`} multiline maw={360}>
                        <Badge color={w.lastDelivery.ok ? 'green' : 'red'} variant="light">
                          {w.lastDelivery.statusCode ?? t('common.error')}
                        </Badge>
                      </Tooltip>
                      <Text size="xs" c="dimmed">
                        {fmtDateTime(w.lastDelivery.at)}
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t('webhooks.never')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={0} justify="flex-end" wrap="nowrap">
                    <IconButton label={t('webhooks.test')} onClick={() => void test(w)} loading={testing === w.id}>
                      <IconSend size={16} />
                    </IconButton>
                    <IconButton label={t('webhooks.deliveries')} onClick={() => setLog(w)}>
                      <IconList size={16} />
                    </IconButton>
                    <IconButton
                      label={t('common.edit')}
                      onClick={() => setForm({ ...w, doorIds: w.doorIds.map(String), headers: headersText(w.headers) })}
                    >
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label={t('common.delete')} color="red" onClick={() => remove(w)}>
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
        {t('webhooks.docs')}
      </Text>

      <Modal opened={!!form} onClose={() => setForm(null)} title={form?.id ? t('webhooks.editTitle') : t('webhooks.newTitle')} size="lg">
        {form && (
          <Stack>
            <TextInput label={t('webhooks.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
            <TextInput label={t('webhooks.url')} description={t('webhooks.urlHint')} classNames={{ input: 'mono' }} value={form.url} onChange={(e) => setForm({ ...form, url: e.currentTarget.value })} />
            <Checkbox.Group label={t('webhooks.events')} value={form.events} onChange={(v) => setForm({ ...form, events: v as WebhookEvent[] })}>
              <Stack gap={6} mt={6}>
                {WEBHOOK_EVENTS.map((e) => (
                  <Checkbox key={e} value={e} label={eventLabel(e)} />
                ))}
              </Stack>
            </Checkbox.Group>
            <MultiSelect
              label={t('webhooks.doors')}
              description={t('webhooks.doorsHint')}
              placeholder={form.doorIds.length ? undefined : t('webhooks.allDoors')}
              data={(doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
              value={form.doorIds}
              onChange={(v) => setForm({ ...form, doorIds: v })}
              searchable
            />
            <Textarea
              label={t('webhooks.headers')}
              description={t('webhooks.headersHint')}
              classNames={{ input: 'mono' }}
              autosize
              minRows={2}
              value={form.headers}
              error={headersError}
              onChange={(e) => setForm({ ...form, headers: e.currentTarget.value })}
            />
            {form.id && form.secret ? (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  {t('webhooks.secret')}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  <Code style={{ wordBreak: 'break-all', flex: 1 }}>{form.secret}</Code>
                  <CopyButton value={form.secret}>
                    {({ copied, copy }) => (
                      <IconButton label={copied ? t('webhooks.copied') : t('webhooks.copy')} onClick={copy} color={copied ? 'green' : undefined}>
                        <IconCopy size={16} />
                      </IconButton>
                    )}
                  </CopyButton>
                  <IconButton label={t('webhooks.regenerate')} onClick={() => regenerate(form.id!, form.name)}>
                    <IconRefresh size={16} />
                  </IconButton>
                </Group>
                <Text size="xs" c="dimmed">
                  {t('webhooks.secretHint')}
                </Text>
              </Stack>
            ) : (
              <Alert color="gray">{t('webhooks.secretAfterSave')}</Alert>
            )}
            <Switch label={t('webhooks.enabledSwitch')} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })} />
            <Button onClick={() => void save()} disabled={!form.name || !/^https?:\/\/.+/i.test(form.url) || form.events.length === 0 || !!headersError}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>

      <DeliveriesModal webhook={log} onClose={() => setLog(null)} eventLabel={eventLabel} />
    </>
  )
}

function DeliveriesModal({ webhook, onClose, eventLabel }: { webhook: WebhookDto | null; onClose: () => void; eventLabel: (e: string) => string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<number | null>(null)
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', webhook?.id],
    queryFn: () => api.get<WebhookDeliveryDto[]>(`/webhooks/${webhook!.id}/deliveries`),
    enabled: !!webhook,
    refetchInterval: 5000,
  })

  return (
    <Modal opened={!!webhook} onClose={onClose} title={webhook ? t('webhooks.deliveriesTitle', { name: webhook.name }) : ''} size="xl">
      {deliveries.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('webhooks.noDeliveries')}
        </Text>
      )}
      {!!deliveries.data?.length && (
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('webhooks.colTime')}</Table.Th>
              <Table.Th>{t('webhooks.colEvent')}</Table.Th>
              <Table.Th>{t('webhooks.colOutcome')}</Table.Th>
              <Table.Th>{t('webhooks.colDuration')}</Table.Th>
              <Table.Th>{t('webhooks.colAttempts')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {deliveries.data.map((d) => (
              <Fragment key={d.id}>
                <Table.Tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <Table.Td>{fmtDateTime(d.at)}</Table.Td>
                  <Table.Td>{eventLabel(d.event)}</Table.Td>
                  <Table.Td>
                    <Badge color={d.ok ? 'green' : 'red'} variant="light">
                      {d.statusCode ?? t('common.error')}
                    </Badge>
                    {d.error && (
                      <Text span size="xs" c="dimmed" ml="xs">
                        {d.error}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{d.durationMs} ms</Table.Td>
                  <Table.Td>{d.attempts}</Table.Td>
                </Table.Tr>
                {open === d.id && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Code block>{JSON.stringify(JSON.parse(d.payload), null, 2)}</Code>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  )
}
