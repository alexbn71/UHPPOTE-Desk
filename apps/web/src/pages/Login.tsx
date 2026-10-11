import { Alert, Button, Center, Group, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core'
import { IconShieldLock } from '@tabler/icons-react'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { LanguageSelect } from '../components/LanguageSelect'
import { api, errorMessage } from '../lib/api'
import type { CurrentUser } from '../lib/auth'

export function LoginPage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
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
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Paper withBorder shadow="md" p="xl" w={360}>
        <form onSubmit={submit}>
          <Stack>
            <Group justify="flex-end" mb={-16}>
              <LanguageSelect />
            </Group>
            <Center>
              <IconShieldLock size={48} color="var(--mantine-color-blue-6)" />
            </Center>
            <Title order={3} ta="center">
              {t('app.name')}
            </Title>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput label={t('login.username')} value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoFocus required autoComplete="username" />
            <PasswordInput label={t('login.password')} value={password} onChange={(e) => setPassword(e.currentTarget.value)} required autoComplete="current-password" />
            <Button type="submit" loading={busy} fullWidth>
              {t('login.submit')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
