import { AppShell, Badge, Burger, Center, Group, Loader, NavLink, ScrollArea, Text, Title, Tooltip, UnstyledButton } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import {
  IconActivity,
  IconCalendarTime,
  IconChecklist,
  IconClockHour4,
  IconCpu,
  IconDashboard,
  IconDoor,
  IconHistory,
  IconId,
  IconKey,
  IconLogout,
  IconRefresh,
  IconReportAnalytics,
  IconSettings,
  IconSitemap,
  IconUsers,
  IconUserShield,
  IconWebhook,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import type { Role } from '@uhppote-desk/shared'
import { LanguageSelect } from './components/LanguageSelect'
import { useAuth } from './lib/auth'
import { useCodes } from './lib/codes'
import { LiveProvider, useLive } from './lib/live'
import { AttendancePage } from './pages/Attendance'
import { AuditPage } from './pages/Audit'
import { CardsPage } from './pages/Cards'
import { ChangePasswordPage } from './pages/ChangePassword'
import { ControllerDetailPage } from './pages/ControllerDetail'
import { ControllersPage } from './pages/Controllers'
import { DashboardPage } from './pages/Dashboard'
import { DoorsPage } from './pages/Doors'
import { EventsPage } from './pages/Events'
import { LoginPage } from './pages/Login'
import { MonitorPage } from './pages/Monitor'
import { OperatorsPage } from './pages/Operators'
import { PeoplePage } from './pages/People'
import { PermissionsPage } from './pages/Permissions'
import { StructurePage } from './pages/Structure'
import { SyncPage } from './pages/Sync'
import { SystemPage } from './pages/System'
import { TasksPage } from './pages/Tasks'
import { TimeProfilesPage } from './pages/TimeProfiles'
import { WebhooksPage } from './pages/Webhooks'

type NavKey =
  | 'dashboard'
  | 'monitor'
  | 'events'
  | 'attendance'
  | 'people'
  | 'cards'
  | 'permissions'
  | 'structure'
  | 'controllers'
  | 'doors'
  | 'timeProfiles'
  | 'tasks'
  | 'sync'
  | 'operators'
  | 'audit'
  | 'webhooks'
  | 'systemInfo'

interface NavItem {
  to: string
  label: NavKey
  icon: ReactNode
  role: Role
}

const NAV: { section: 'operations' | 'registry' | 'configuration' | 'administration'; items: NavItem[] }[] = [
  {
    section: 'operations',
    items: [
      { to: '/', label: 'dashboard', icon: <IconDashboard size={18} />, role: 'viewer' },
      { to: '/monitor', label: 'monitor', icon: <IconActivity size={18} />, role: 'viewer' },
      { to: '/events', label: 'events', icon: <IconHistory size={18} />, role: 'viewer' },
      { to: '/attendance', label: 'attendance', icon: <IconReportAnalytics size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'registry',
    items: [
      { to: '/people', label: 'people', icon: <IconUsers size={18} />, role: 'viewer' },
      { to: '/cards', label: 'cards', icon: <IconId size={18} />, role: 'viewer' },
      { to: '/permissions', label: 'permissions', icon: <IconKey size={18} />, role: 'viewer' },
      { to: '/structure', label: 'structure', icon: <IconSitemap size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'configuration',
    items: [
      { to: '/controllers', label: 'controllers', icon: <IconCpu size={18} />, role: 'viewer' },
      { to: '/doors', label: 'doors', icon: <IconDoor size={18} />, role: 'viewer' },
      { to: '/time-profiles', label: 'timeProfiles', icon: <IconClockHour4 size={18} />, role: 'viewer' },
      { to: '/tasks', label: 'tasks', icon: <IconCalendarTime size={18} />, role: 'viewer' },
      { to: '/sync', label: 'sync', icon: <IconRefresh size={18} />, role: 'operator' },
    ],
  },
  {
    section: 'administration',
    items: [
      { to: '/operators', label: 'operators', icon: <IconUserShield size={18} />, role: 'admin' },
      { to: '/audit', label: 'audit', icon: <IconChecklist size={18} />, role: 'admin' },
      { to: '/webhooks', label: 'webhooks', icon: <IconWebhook size={18} />, role: 'admin' },
      { to: '/system', label: 'systemInfo', icon: <IconSettings size={18} />, role: 'viewer' },
    ],
  },
]

function Shell({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure()
  const { user, logout, can } = useAuth()
  const { t } = useTranslation()
  const codes = useCodes()
  const live = useLive()
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <img src="/icon.svg" width={28} height={28} alt="" />
            <Title order={4}>{t('app.name')}</Title>
            <Tooltip label={live.connected ? t('nav.liveOn') : t('nav.liveOff')}>
              <Badge color={live.connected ? 'green' : 'red'} variant="dot">
                {live.connected ? t('common.live') : t('common.offline')}
              </Badge>
            </Tooltip>
          </Group>
          <Group gap="sm">
            <Text size="sm" visibleFrom="xs">
              {user?.displayName} · {user ? codes.role(user.role) : ''}
            </Text>
            <LanguageSelect />
            {!user?.passwordManaged && (
              <Tooltip label={t('nav.changePassword')}>
                <UnstyledButton onClick={() => navigate('/password')}>
                  <IconKey size={20} />
                </UnstyledButton>
              </Tooltip>
            )}
            <Tooltip label={t('nav.logout')}>
              <UnstyledButton onClick={() => void logout()}>
                <IconLogout size={20} />
              </UnstyledButton>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((section) => {
            const items = section.items.filter((i) => can(i.role))
            if (!items.length) return null
            return (
              <div key={section.section}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase" px="sm" pt="sm" pb={4}>
                  {t(`nav.${section.section}`)}
                </Text>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    label={t(`nav.${item.label}`)}
                    leftSection={item.icon}
                    active={item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)}
                    onClick={() => {
                      navigate(item.to)
                      close()
                    }}
                  />
                ))}
              </div>
            )
          })}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  )
}

function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useAuth()
  return can(role) ? <>{children}</> : <Navigate to="/" replace />
}

export function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  return (
    <BrowserRouter>
      {!user ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : user.mustChangePassword ? (
        <ChangePasswordPage forced />
      ) : (
        <LiveProvider enabled>
          <Shell>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/monitor" element={<MonitorPage />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/attendance" element={<AttendancePage />} />
              <Route path="/people" element={<PeoplePage />} />
              <Route path="/cards" element={<CardsPage />} />
              <Route path="/permissions" element={<PermissionsPage />} />
              <Route path="/structure" element={<StructurePage />} />
              <Route path="/controllers" element={<ControllersPage />} />
              <Route path="/controllers/:id" element={<ControllerDetailPage />} />
              <Route path="/doors" element={<DoorsPage />} />
              <Route path="/time-profiles" element={<TimeProfilesPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/sync" element={<Guard role="operator"><SyncPage /></Guard>} />
              <Route path="/operators" element={<Guard role="admin"><OperatorsPage /></Guard>} />
              <Route path="/audit" element={<Guard role="admin"><AuditPage /></Guard>} />
              <Route path="/webhooks" element={<Guard role="admin"><WebhooksPage /></Guard>} />
              <Route path="/system" element={<SystemPage />} />
              <Route path="/password" element={<ChangePasswordPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        </LiveProvider>
      )}
    </BrowserRouter>
  )
}
