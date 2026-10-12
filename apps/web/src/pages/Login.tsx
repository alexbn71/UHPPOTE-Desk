import { Alert, Button, Center, Checkbox, Group, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { LanguageSelect } from '../components/LanguageSelect'
import { api, errorMessage } from '../lib/api'
import type { CurrentUser } from '../lib/auth'
import { deviceName, prefersRemember } from '../lib/device'

export function LoginPage() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(prefersRemember)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ user: CurrentUser }>('/auth/login', {
        username,
        password,
        remember,
        deviceName: deviceName(),
      })
      qc.setQueryData(['me'], r.user)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Center h="100vh" bg="var(--mantine-color-gray-light)">
      <Paper withBorder shadow="md" p="xl" w={360} maw="calc(100vw - 32px)">
        <form onSubmit={submit}>
          <Stack>
            <Group justify="flex-end" mb={-16}>
              <LanguageSelect />
            </Group>
            <Center>
              <img src="/icon.svg" width={64} height={64} alt="" />
            </Center>
            <Title order={3} ta="center">
              {t('app.name')}
            </Title>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput
              label={t('login.username')}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              autoFocus
              required
              autoComplete="username"
            />
            <PasswordInput
              label={t('login.password')}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
              autoComplete="current-password"
            />
            <Checkbox
              label={t('login.remember')}
              description={t('login.rememberHint')}
              checked={remember}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            <Button type="submit" loading={busy} fullWidth>
              {t('login.submit')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
