import { Alert, Button, Card, SimpleGrid, Table, Text, Title } from '@mantine/core'
import type { ReactNode } from 'react'
import { IconDatabaseExport } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDateTime } from '../lib/format'

interface SystemInfo {
  version: string
  node: string
  hostname: string
  uptimeSec: number
  interfaces: { name: string; address: string; netmask: string }[]
  uhppote: { bindAddress: string; broadcast: string; listen: string; listenerPublic: string | null; timeoutMs: number }
  counts: { people: number; cards: number; events: number; controllers: number }
}

export function SystemPage() {
  const { t } = useTranslation()
  const { can } = useAuth()
  const info = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/system/info') })
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ name: string; size: number; createdAt: string }[]>('/system/backups'), enabled: can('admin') })
  const d = info.data

  const row = (label: string, value: ReactNode, mono = false) => (
    <Table.Tr>
      <Table.Td c="dimmed">{label}</Table.Td>
      <Table.Td className={mono ? 'mono' : undefined}>{value}</Table.Td>
    </Table.Tr>
  )

  return (
    <>
      <PageHeader title={t('system.title')} description={t('system.description')} />
      {d && (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder>
            <Title order={5} mb="xs">
              {t('system.server')}
            </Title>
            <Table>
              <Table.Tbody>
                {row(t('system.version'), d.version)}
                {row(t('system.host'), `${d.hostname} (Node ${d.node})`)}
                {row(t('system.uptime'), t('system.uptimeValue', { h: Math.floor(d.uptimeSec / 3600), m: Math.floor((d.uptimeSec % 3600) / 60) }))}
                {row(t('system.interfaces'), d.interfaces.map((i) => `${i.name}: ${i.address}/${i.netmask}`).join('\n'), true)}
                {row(t('system.data'), t('system.dataValue', d.counts))}
              </Table.Tbody>
            </Table>
          </Card>
          <Card withBorder>
            <Title order={5} mb="xs">
              {t('system.communication')}
            </Title>
            <Table>
              <Table.Tbody>
                {row(t('system.bind'), d.uhppote.bindAddress, true)}
                {row(t('system.broadcast'), d.uhppote.broadcast, true)}
                {row(t('system.listen'), d.uhppote.listen, true)}
                {row(t('system.listenerPublic'), d.uhppote.listenerPublic ?? <Text span c="orange">{t('system.notSet')}</Text>, true)}
                {row(t('system.timeout'), `${d.uhppote.timeoutMs} ms`)}
              </Table.Tbody>
            </Table>
            {!d.uhppote.listenerPublic && (
              <Alert color="orange" mt="sm">
                {t('system.listenerWarning')}
              </Alert>
            )}
          </Card>
          {can('admin') && (
            <Card withBorder>
              <Title order={5} mb="xs">
                {t('system.backups')}
              </Title>
              <Text size="sm" c="dimmed" mb="sm">
                {t('system.backupsInfo')}
              </Text>
              <Button
                leftSection={<IconDatabaseExport size={16} />}
                variant="light"
                mb="sm"
                onClick={() =>
                  void api
                    .post('/system/backups')
                    .then(() => {
                      notifyOk(t('system.backupCreated'))
                      void backups.refetch()
                    })
                    .catch(notifyError)
                }
              >
                {t('system.backupNow')}
              </Button>
              <Table>
                <Table.Tbody>
                  {(backups.data ?? []).map((b) => (
                    <Table.Tr key={b.name}>
                      <Table.Td className="mono">{b.name}</Table.Td>
                      <Table.Td>{(b.size / 1024 / 1024).toFixed(1)} MB</Table.Td>
                      <Table.Td>{fmtDateTime(b.createdAt.replace('T', ' ').slice(0, 19))}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          )}
        </SimpleGrid>
      )}
    </>
  )
}
