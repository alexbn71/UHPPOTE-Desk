import { Alert, Anchor, Badge, Button, Card, Group, Select, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconDeviceFloppy, IconFingerprint, IconBell, IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceDto, MobileSettings, OpenConfirmation } from '@uhppote-desk/shared'
import { MOBILE_SESSION_DAYS, OPEN_CONFIRMATIONS } from '@uhppote-desk/shared'
import { IconButton, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { fmtDate, fmtDateTime } from '../lib/format'

/** Administration of the mobile app: opening confirmation, login duration, remembered devices. */
export function MobileAdminPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['mobile-settings'],
    queryFn: () => api.get<MobileSettings>('/mobile/settings'),
  })
  const devices = useQuery({ queryKey: ['mobile-devices'], queryFn: () => api.get<DeviceDto[]>('/mobile/devices') })
  const [form, setForm] = useState<MobileSettings | null>(null)
  useEffect(() => {
    if (settings.data) setForm(settings.data)
  }, [settings.data])

  const save = () =>
    api
      .put('/mobile/settings', form)
      .then(() => {
        notifyOk(t('mobileAdmin.saved'))
        void qc.invalidateQueries({ queryKey: ['mobile-settings'] })
        void qc.invalidateQueries({ queryKey: ['mobile-devices'] })
      })
      .catch(notifyError)

  const revoke = (d: DeviceDto) =>
    modals.openConfirmModal({
      title: t('mobileAdmin.revokeTitle', { name: d.name, operator: d.operatorName }),
      children: <Text size="sm">{t('mobileAdmin.revokeInfo')}</Text>,
      labels: { confirm: t('mobileAdmin.revoke'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        api
          .del(`/mobile/devices/${d.id}`)
          .then(() => qc.invalidateQueries({ queryKey: ['mobile-devices'] }))
          .catch(notifyError),
    })

  const appUrl = `${location.origin}/m`

  return (
    <>
      <PageHeader title={t('mobileAdmin.title')} description={t('mobileAdmin.description')} />
      <Stack>
        <Alert color={location.protocol === 'https:' ? 'blue' : 'orange'}>
          <Text size="sm">{t('mobileAdmin.httpsHint')}</Text>
          <Text size="sm" mt={4}>
            {t('mobileAdmin.link', { url: '' })}
            <Anchor href={appUrl}>{appUrl}</Anchor>
          </Text>
        </Alert>
        {form && (
          <Card withBorder maw={720}>
            <Title order={5} mb="sm">
              {t('mobileAdmin.settings')}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('mobileAdmin.confirmation')}
                description={t('mobileAdmin.confirmationHint')}
                data={OPEN_CONFIRMATIONS.map((c) => ({ value: c, label: t(`codes.openConfirmation.${c}`) }))}
                value={form.openConfirmation}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, openConfirmation: (v ?? 'press') as OpenConfirmation })}
              />
              <Select
                label={t('mobileAdmin.sessionDays')}
                description={t('mobileAdmin.sessionDaysHint')}
                data={MOBILE_SESSION_DAYS.map((d) => ({ value: String(d), label: t('mobileAdmin.days', { n: d }) }))}
                value={String(form.sessionDays)}
                allowDeselect={false}
                onChange={(v) => setForm({ ...form, sessionDays: Number(v ?? 90) })}
              />
            </SimpleGrid>
            <Group justify="flex-end" mt="md">
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            </Group>
          </Card>
        )}
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('mobileAdmin.devices')}
          </Title>
          {devices.data?.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('mobileAdmin.noDevices')}
            </Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('mobileAdmin.colOperator')}</Table.Th>
                  <Table.Th>{t('mobileAdmin.colDevice')}</Table.Th>
                  <Table.Th>{t('mobileAdmin.colCreated')}</Table.Th>
                  <Table.Th>{t('mobileAdmin.colLastUsed')}</Table.Th>
                  <Table.Th>{t('mobileAdmin.colSecurity')}</Table.Th>
                  <Table.Th>{t('mobileAdmin.colExpires')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(devices.data ?? []).map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>{d.operatorName}</Table.Td>
                    <Table.Td>{d.name}</Table.Td>
                    <Table.Td>{fmtDate(d.createdAt.slice(0, 10))}</Table.Td>
                    <Table.Td>
                      {d.lastUsedAt ? (
                        <Stack gap={0}>
                          <Text size="sm">{fmtDateTime(d.lastUsedAt)}</Text>
                          <Text size="xs" c="dimmed" className="mono">
                            {d.lastIp}
                          </Text>
                        </Stack>
                      ) : (
                        t('mobileAdmin.never')
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {d.biometric && (
                          <Badge variant="light" color="teal" leftSection={<IconFingerprint size={12} />}>
                            {t('mobileAdmin.biometric')}
                          </Badge>
                        )}
                        {d.push && (
                          <Badge variant="light" leftSection={<IconBell size={12} />}>
                            {t('mobileAdmin.push')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{d.expiresAt ? fmtDate(d.expiresAt.slice(0, 10)) : t('mobileAdmin.noExpiry')}</Table.Td>
                    <Table.Td>
                      <IconButton label={t('mobileAdmin.revoke')} color="red" onClick={() => revoke(d)}>
                        <IconTrash size={16} />
                      </IconButton>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
      </Stack>
    </>
  )
}
