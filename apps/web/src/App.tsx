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
  IconShieldLock,
  IconSitemap,
  IconUsers,
  IconUserShield,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import type { Role } from '@uhppote-desk/shared'
import { ROLE_LABELS } from '@uhppote-desk/shared'
import { useAuth } from './lib/auth'
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

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  role: Role
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Operatività',
    items: [
      { to: '/', label: 'Dashboard', icon: <IconDashboard size={18} />, role: 'viewer' },
      { to: '/monitor', label: 'Monitor', icon: <IconActivity size={18} />, role: 'viewer' },
      { to: '/eventi', label: 'Storico eventi', icon: <IconHistory size={18} />, role: 'viewer' },
      { to: '/presenze', label: 'Presenze', icon: <IconReportAnalytics size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'Anagrafica',
    items: [
      { to: '/persone', label: 'Persone', icon: <IconUsers size={18} />, role: 'viewer' },
      { to: '/tessere', label: 'Tessere', icon: <IconId size={18} />, role: 'viewer' },
      { to: '/permessi', label: 'Permessi', icon: <IconKey size={18} />, role: 'viewer' },
      { to: '/struttura', label: 'Reparti e zone', icon: <IconSitemap size={18} />, role: 'viewer' },
    ],
  },
  {
    section: 'Configurazione',
    items: [
      { to: '/controller', label: 'Controller', icon: <IconCpu size={18} />, role: 'viewer' },
      { to: '/porte', label: 'Porte', icon: <IconDoor size={18} />, role: 'viewer' },
      { to: '/fasce-orarie', label: 'Fasce orarie', icon: <IconClockHour4 size={18} />, role: 'viewer' },
      { to: '/task', label: 'Task programmati', icon: <IconCalendarTime size={18} />, role: 'viewer' },
      { to: '/sincronizzazione', label: 'Sincronizzazione', icon: <IconRefresh size={18} />, role: 'operator' },
    ],
  },
  {
    section: 'Amministrazione',
    items: [
      { to: '/operatori', label: 'Operatori', icon: <IconUserShield size={18} />, role: 'admin' },
      { to: '/audit', label: 'Registro operazioni', icon: <IconChecklist size={18} />, role: 'admin' },
      { to: '/sistema', label: 'Sistema', icon: <IconSettings size={18} />, role: 'viewer' },
    ],
  },
]

function Shell({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure()
  const { user, logout, can } = useAuth()
  const live = useLive()
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <IconShieldLock size={24} color="var(--mantine-color-blue-6)" />
            <Title order={4}>UHPPOTE Desk</Title>
            <Tooltip label={live.connected ? 'Aggiornamenti in tempo reale attivi' : 'Connessione in tempo reale assente'}>
              <Badge color={live.connected ? 'green' : 'red'} variant="dot">
                {live.connected ? 'Live' : 'Offline'}
              </Badge>
            </Tooltip>
          </Group>
          <Group gap="sm">
            <Text size="sm" visibleFrom="xs">
              {user?.displayName} · {user ? ROLE_LABELS[user.role] : ''}
            </Text>
            <Tooltip label="Cambia password">
              <UnstyledButton onClick={() => navigate('/password')}>
                <IconKey size={20} />
              </UnstyledButton>
            </Tooltip>
            <Tooltip label="Esci">
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
                  {section.section}
                </Text>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    label={item.label}
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
              <Route path="/eventi" element={<EventsPage />} />
              <Route path="/presenze" element={<AttendancePage />} />
              <Route path="/persone" element={<PeoplePage />} />
              <Route path="/tessere" element={<CardsPage />} />
              <Route path="/permessi" element={<PermissionsPage />} />
              <Route path="/struttura" element={<StructurePage />} />
              <Route path="/controller" element={<ControllersPage />} />
              <Route path="/controller/:id" element={<ControllerDetailPage />} />
              <Route path="/porte" element={<DoorsPage />} />
              <Route path="/fasce-orarie" element={<TimeProfilesPage />} />
              <Route path="/task" element={<TasksPage />} />
              <Route path="/sincronizzazione" element={<Guard role="operator"><SyncPage /></Guard>} />
              <Route path="/operatori" element={<Guard role="admin"><OperatorsPage /></Guard>} />
              <Route path="/audit" element={<Guard role="admin"><AuditPage /></Guard>} />
              <Route path="/sistema" element={<SystemPage />} />
              <Route path="/password" element={<ChangePasswordPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        </LiveProvider>
      )}
    </BrowserRouter>
  )
}
