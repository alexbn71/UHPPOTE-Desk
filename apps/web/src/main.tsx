import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dates/styles.css'
import '@mantine/charts/styles.css'
import './styles.css'
import './i18n'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import { DatesProvider } from '@mantine/dates'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { App } from './App'
import { AuthProvider } from './lib/auth'

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
})

/** Providers whose texts/formats depend on the current language. */
function LocalizedProviders({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation()
  const locale = (i18n.resolvedLanguage ?? 'en').slice(0, 2)
  return (
    <DatesProvider settings={{ locale, firstDayOfWeek: 1 }}>
      <ModalsProvider labels={{ confirm: t('common.confirm'), cancel: t('common.cancel') }}>{children}</ModalsProvider>
    </DatesProvider>
  )
}

// service worker: installable app, push notifications (production build only)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <QueryClientProvider client={queryClient}>
        <LocalizedProviders>
          <Notifications position="top-right" />
          <AuthProvider>
            <App />
          </AuthProvider>
        </LocalizedProviders>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
)
