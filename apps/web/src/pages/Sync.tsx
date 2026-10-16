import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconRefresh, IconSearch, IconUpload } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControllerDto, SyncDiffDto } from '@uhppote-desk/shared'
import { ControllerStatusBadge, PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

const preview = (list: number[]) => (list.length > 0 ? ` (${list.slice(0, 10).join(', ')}${list.length > 10 ? '…' : ''})` : '')

function SyncCard({ c }: { c: ControllerDto }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const live = useLive()
  const [diff, setDiff] = useState<SyncDiffDto | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const progress = live.sync[c.id]
  const online = live.states[c.id]?.online ?? c.online

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    try {
      await fn()
    } catch (err) {
      notifyError(err)
    } finally {
      setBusy(null)
    }
  }

  const check = () => run('diff', async () => setDiff(await api.get<SyncDiffDto>(`/controllers/${c.id}/sync/diff`)))
  const syncCards = () =>
    run('cards', async () => {
      const r = await api.post<SyncDiffDto>(`/controllers/${c.id}/sync/cards`)
      notifyOk(t('sync.cardsDone', { name: c.name, added: r.toAdd.length, updated: r.toUpdate.length, deleted: r.toDelete.length }))
      setDiff(null)
    })
  const syncAll = () =>
    modals.openConfirmModal({
      title: t('sync.syncAllTitle', { name: c.name }),
      children: <Text size="sm">{t('sync.syncAllInfo')}</Text>,
      labels: { confirm: t('sync.syncAllConfirm'), cancel: t('common.cancel') },
      onConfirm: () =>
        void run('all', async () => {
          await api.post(`/controllers/${c.id}/sync/all`)
          notifyOk(t('sync.syncAllDone', { name: c.name }))
          setDiff(null)
        }),
    })

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>{c.name}</Title>
        <ControllerStatusBadge enabled={c.enabled} online={online} />
      </Group>
      <Stack>
        {progress && busy && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">{t(progress.code as 'sync.progress.doors', progress.params)}</Text>
          </Group>
        )}
        {diff && (
          <Alert color={diff.toAdd.length + diff.toUpdate.length + diff.toDelete.length === 0 ? 'green' : 'orange'} variant="light">
            <Text size="sm">{t('sync.diffCards', { total: diff.controllerCards, unchanged: diff.unchanged })}</Text>
            <Text size="sm">{t('sync.diffAdd', { n: diff.toAdd.length }) + preview(diff.toAdd)}</Text>
            <Text size="sm">{t('sync.diffUpdate', { n: diff.toUpdate.length })}</Text>
            <Text size="sm">{t('sync.diffDelete', { n: diff.toDelete.length }) + preview(diff.toDelete)}</Text>
          </Alert>
        )}
        <Group>
          <Button variant="default" leftSection={<IconSearch size={16} />} loading={busy === 'diff'} disabled={!online || !!busy} onClick={() => void check()}>
            {t('sync.compare')}
          </Button>
          <Button leftSection={<IconUpload size={16} />} loading={busy === 'cards'} disabled={!online || !!busy} onClick={() => void syncCards()}>
            {t('sync.syncCards')}
          </Button>
          {can('admin') && (
            <Button variant="light" leftSection={<IconRefresh size={16} />} loading={busy === 'all'} disabled={!online || !!busy} onClick={syncAll}>
              {t('sync.syncAll')}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  )
}

export function SyncPage() {
  const { t } = useTranslation()
  const controllers = useControllers()
  return (
    <>
      <PageHeader title={t('sync.title')} description={t('sync.description')} />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {(controllers.data ?? []).filter((c) => c.enabled).map((c) => <SyncCard key={c.id} c={c} />)}
      </SimpleGrid>
    </>
  )
}
