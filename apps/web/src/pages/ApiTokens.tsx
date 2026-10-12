import { Alert, Badge, Button, Card, Code, CopyButton, Group, Modal, MultiSelect, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core'
import { DateInput } from '@mantine/dates'
import { modals } from '@mantine/modals'
import { IconCopy, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApiTokenDto, TokenAccess } from '@uhppote-desk/shared'
import { TOKEN_ACCESS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError } from '../lib/api'
import { DATE_INPUT_FORMAT, fmtDate, fmtDateTime, today } from '../lib/format'
import { treeOptions, useDoors, useZones } from '../lib/queries'

interface Form {
  id?: number
  name: string
  access: TokenAccess
  zoneIds: string[]
  doorIds: string[]
  expiresAt: string | null
  active: boolean
}

const ACCESS_COLOR: Record<TokenAccess, string> = { read: 'gray', doors: 'teal', operator: 'blue', admin: 'red' }

export function ApiTokensPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const zones = useZones()
  const doors = useDoors()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<ApiTokenDto[]>('/tokens') })
  const [form, setForm] = useState<Form | null>(null)
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)

  const accessLabel = (a: TokenAccess) => t(`codes.tokenAccess.${a}`)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tokens'] })

  const save = async () => {
    if (!form) return
    try {
      const body = { name: form.name, access: form.access, zoneIds: form.zoneIds.map(Number), doorIds: form.doorIds.map(Number), expiresAt: form.expiresAt, active: form.active }
      if (form.id) await api.put(`/tokens/${form.id}`, body)
      else {
        const r = await api.post<{ token: string; apiToken: ApiTokenDto }>('/tokens', body)
        setCreated({ name: r.apiToken.name, token: r.token })
      }
      setForm(null)
      refresh()
    } catch (err) {
      notifyError(err)
    }
  }

  const remove = (tk: ApiTokenDto) =>
    modals.openConfirmModal({
      title: t('apiTokens.deleteTitle', { name: tk.name }),
      children: <Text size="sm">{t('apiTokens.deleteInfo')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => api.del(`/tokens/${tk.id}`).then(refresh).catch(notifyError),
    })

  const restrictions = (tk: ApiTokenDto) => {
    const parts: string[] = []
    if (tk.zoneIds.length) parts.push(t('apiTokens.zonesValue', { list: tk.zoneIds.map((z) => zones.data?.find((x) => x.id === z)?.name ?? z).join(', ') }))
    if (tk.doorIds.length) parts.push(t('apiTokens.doorsValue', { list: tk.doorIds.map((d) => doors.data?.find((x) => x.id === d)?.name ?? d).join(', ') }))
    return parts.length ? parts.join(' · ') : t('apiTokens.unrestricted')
  }

  return (
    <>
      <PageHeader
        title={t('apiTokens.title')}
        description={t('apiTokens.description')}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ name: '', access: 'read', zoneIds: [], doorIds: [], expiresAt: null, active: true })}>
            {t('apiTokens.new')}
          </Button>
        }
      />
      {created && (
        <Alert color="blue" withCloseButton onClose={() => setCreated(null)} mb="md" title={`${t('apiTokens.createdTitle')} — ${created.name}`}>
          <Stack gap="xs">
            <Group gap="xs" wrap="nowrap">
              <Code style={{ wordBreak: 'break-all', flex: 1 }}>{created.token}</Code>
              <CopyButton value={created.token}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="light" color={copied ? 'green' : 'blue'} leftSection={<IconCopy size={14} />} onClick={copy}>
                    {copied ? t('apiTokens.copied') : t('apiTokens.copy')}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Text size="sm">{t('apiTokens.createdInfo')}</Text>
            <Code block>{t('apiTokens.usage', { url: window.location.origin })}</Code>
          </Stack>
        </Alert>
      )}
      <Card withBorder>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('apiTokens.colName')}</Table.Th>
              <Table.Th>{t('apiTokens.colToken')}</Table.Th>
              <Table.Th>{t('apiTokens.colAccess')}</Table.Th>
              <Table.Th>{t('apiTokens.colRestrictions')}</Table.Th>
              <Table.Th>{t('apiTokens.colExpires')}</Table.Th>
              <Table.Th>{t('apiTokens.colLastUsed')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(tokens.data ?? []).map((tk) => {
              const expired = tk.expiresAt !== null && tk.expiresAt < today()
              return (
                <Table.Tr key={tk.id} opacity={tk.active && !expired ? 1 : 0.5}>
                  <Table.Td>{tk.name}</Table.Td>
                  <Table.Td className="mono">{tk.prefix}…</Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={ACCESS_COLOR[tk.access]}>
                      {accessLabel(tk.access)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{restrictions(tk)}</Table.Td>
                  <Table.Td>
                    {tk.expiresAt ? fmtDate(tk.expiresAt) : t('apiTokens.noExpiry')}
                    {expired && (
                      <Badge color="red" variant="light" ml="xs">
                        {t('apiTokens.expired')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {tk.lastUsedAt ? (
                      <Stack gap={0}>
                        <Text size="sm">{fmtDateTime(tk.lastUsedAt)}</Text>
                        <Text size="xs" c="dimmed" className="mono">
                          {tk.lastUsedIp}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('apiTokens.never')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={0} justify="flex-end" wrap="nowrap">
                      <IconButton label={t('common.edit')} onClick={() => setForm({ ...tk, zoneIds: tk.zoneIds.map(String), doorIds: tk.doorIds.map(String) })}>
                        <IconEdit size={16} />
                      </IconButton>
                      <IconButton label={t('common.delete')} color="red" onClick={() => remove(tk)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              )
            })}
          </Table.Tbody>
        </Table>
      </Card>
      <Text size="xs" c="dimmed" mt="xs">
        {t('apiTokens.docs')}
      </Text>

      <Modal opened={!!form} onClose={() => setForm(null)} title={form?.id ? t('apiTokens.editTitle') : t('apiTokens.newTitle')} size="lg">
        {form && (
          <Stack>
            <TextInput label={t('apiTokens.name')} description={t('apiTokens.nameHint')} value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
            <Select
              label={t('apiTokens.access')}
              description={t('apiTokens.accessHint')}
              data={TOKEN_ACCESS.map((a) => ({ value: a, label: accessLabel(a) }))}
              value={form.access}
              onChange={(v) => setForm({ ...form, access: (v as TokenAccess) ?? 'read' })}
              allowDeselect={false}
            />
            <MultiSelect
              label={t('apiTokens.zones')}
              description={t('apiTokens.zonesHint')}
              data={treeOptions(zones.data)}
              value={form.zoneIds}
              onChange={(v) => setForm({ ...form, zoneIds: v })}
            />
            {form.access !== 'read' && (
              <MultiSelect
                label={t('apiTokens.doors')}
                description={t('apiTokens.doorsHint')}
                data={(doors.data ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
                value={form.doorIds}
                onChange={(v) => setForm({ ...form, doorIds: v })}
                searchable
              />
            )}
            <DateInput
              label={t('apiTokens.expiresAt')}
              description={t('apiTokens.expiresHint')}
              valueFormat={DATE_INPUT_FORMAT}
              value={form.expiresAt}
              onChange={(v) => setForm({ ...form, expiresAt: v || null })}
              clearable
            />
            <Switch label={t('apiTokens.activeSwitch')} checked={form.active} onChange={(e) => setForm({ ...form, active: e.currentTarget.checked })} />
            <Button onClick={() => void save()} disabled={!form.name.trim()}>
              {t('common.save')}
            </Button>
          </Stack>
        )}
      </Modal>
    </>
  )
}
