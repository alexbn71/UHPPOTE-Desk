import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { IconRefresh, IconSearch, IconUpload } from '@tabler/icons-react'
import { useState } from 'react'
import type { ControllerDto, SyncDiffDto } from '@uhppote-desk/shared'
import { PageHeader } from '../components/common'
import { api, notifyError, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useLive } from '../lib/live'
import { useControllers } from '../lib/queries'

function SyncCard({ c }: { c: ControllerDto }) {
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
      notifyOk(`${c.name}: ${r.toAdd.length} aggiunte, ${r.toUpdate.length} aggiornate, ${r.toDelete.length} rimosse`)
      setDiff(null)
    })
  const syncAll = () =>
    modals.openConfirmModal({
      title: `Sincronizzazione completa di ${c.name}`,
      children: (
        <Text size="sm">
          Verranno reinviati configurazione porte, fasce orarie, task, impostazioni avanzate e tutte le tessere. L'operazione può richiedere qualche minuto.
        </Text>
      ),
      labels: { confirm: 'Sincronizza', cancel: 'Annulla' },
      onConfirm: () =>
        void run('all', async () => {
          await api.post(`/controllers/${c.id}/sync/all`)
          notifyOk(`${c.name}: sincronizzazione completa eseguita`)
          setDiff(null)
        }),
    })

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>{c.name}</Title>
        <Badge color={online ? 'green' : 'red'}>{online ? 'Online' : 'Offline'}</Badge>
      </Group>
      <Stack>
        {progress && busy && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">{progress.message}</Text>
          </Group>
        )}
        {diff && (
          <Alert color={diff.toAdd.length + diff.toUpdate.length + diff.toDelete.length === 0 ? 'green' : 'orange'} variant="light">
            <Text size="sm">
              Tessere sul controller: {diff.controllerCards} · allineate: {diff.unchanged}
            </Text>
            <Text size="sm">Da aggiungere: {diff.toAdd.length} {diff.toAdd.length > 0 && `(${diff.toAdd.slice(0, 10).join(', ')}${diff.toAdd.length > 10 ? '…' : ''})`}</Text>
            <Text size="sm">Da aggiornare: {diff.toUpdate.length}</Text>
            <Text size="sm">
              Da rimuovere (presenti sul controller ma non nel database): {diff.toDelete.length}{' '}
              {diff.toDelete.length > 0 && `(${diff.toDelete.slice(0, 10).join(', ')}${diff.toDelete.length > 10 ? '…' : ''})`}
            </Text>
          </Alert>
        )}
        <Group>
          <Button variant="default" leftSection={<IconSearch size={16} />} loading={busy === 'diff'} disabled={!online || !!busy} onClick={() => void check()}>
            Confronta
          </Button>
          <Button leftSection={<IconUpload size={16} />} loading={busy === 'cards'} disabled={!online || !!busy} onClick={() => void syncCards()}>
            Allinea tessere
          </Button>
          {can('admin') && (
            <Button variant="light" leftSection={<IconRefresh size={16} />} loading={busy === 'all'} disabled={!online || !!busy} onClick={syncAll}>
              Sincronizzazione completa
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  )
}

export function SyncPage() {
  const controllers = useControllers()
  return (
    <>
      <PageHeader
        title="Sincronizzazione"
        description="Il database dell'applicazione è la fonte di verità: le modifiche vengono inviate subito ai controller online; qui puoi verificare e riallineare (es. dopo che un controller è rimasto offline)."
      />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {(controllers.data ?? []).filter((c) => c.enabled).map((c) => <SyncCard key={c.id} c={c} />)}
      </SimpleGrid>
    </>
  )
}
