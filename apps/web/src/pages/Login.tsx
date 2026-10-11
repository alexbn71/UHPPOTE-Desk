import { Alert, Button, Center, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core'
import { IconShieldLock } from '@tabler/icons-react'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { CurrentUser } from '../lib/auth'

export function LoginPage() {
  const qc = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ user: CurrentUser }>('/auth/login', { username, password })
      qc.setQueryData(['me'], r.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Paper withBorder shadow="md" p="xl" w={360}>
        <form onSubmit={submit}>
          <Stack>
            <Center>
              <IconShieldLock size={48} color="var(--mantine-color-blue-6)" />
            </Center>
            <Title order={3} ta="center">
              UHPPOTE Desk
            </Title>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput label="Utente" value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoFocus required autoComplete="username" />
            <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required autoComplete="current-password" />
            <Button type="submit" loading={busy} fullWidth>
              Accedi
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
