import { Alert, Button, Center, Paper, PasswordInput, Stack, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { api, notifyOk } from '../lib/api'
import { useAuth } from '../lib/auth'

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { refresh, logout } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== confirm) return setError('Le due password non coincidono')
    if (next.length < 8) return setError('La password deve avere almeno 8 caratteri')
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next })
      notifyOk('Password aggiornata')
      setCurrent('')
      setNext('')
      setConfirm('')
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h={forced ? '100vh' : undefined} mt={forced ? 0 : 'xl'}>
      <Paper withBorder shadow="sm" p="xl" w={400}>
        <form onSubmit={submit}>
          <Stack>
            <Title order={3}>Cambio password</Title>
            {forced && <Alert color="blue">Al primo accesso è necessario impostare una nuova password personale.</Alert>}
            {error && <Alert color="red">{error}</Alert>}
            <PasswordInput label="Password attuale" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} required autoComplete="current-password" />
            <PasswordInput label="Nuova password" description="Almeno 8 caratteri" value={next} onChange={(e) => setNext(e.currentTarget.value)} required autoComplete="new-password" />
            <PasswordInput label="Conferma nuova password" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} required autoComplete="new-password" />
            <Button type="submit" loading={busy}>
              Salva
            </Button>
            {forced && (
              <Button variant="subtle" onClick={() => void logout()}>
                Esci
              </Button>
            )}
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
