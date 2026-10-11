import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router'
import { Loading } from '../components/ui'
import { JoinPage } from '../features/auth/JoinPage'
import { LoginPage } from '../features/auth/LoginPage'
import { BalancesPage } from '../features/balances/BalancesPage'
import { DataPage } from '../features/csv/DataPage'
import { ReportPage } from '../features/csv/ReportPage'
import { EditExpensePage, ExpenseDetailPage, ExpensesPage, NewExpensePage } from '../features/expenses/ExpensePages'
import { PeoplePage } from '../features/people/PeoplePage'
import { ProfilePage } from '../features/profile/ProfilePage'
import { RatesPage } from '../features/rates/RatesPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { TripLayout } from '../features/trip/TripLayout'
import { TripPage } from '../features/trip/TripPage'
import { NewTripPage } from '../features/trips/NewTripPage'
import { TripsPage } from '../features/trips/TripsPage'
import { AuthProvider, useAuth } from './auth'
import { Layout } from './Layout'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  const location = useLocation()
  if (!ready) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/join', element: <JoinPage /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <TripsPage /> },
      { path: '/trips/new', element: <NewTripPage /> },
      { path: '/profile', element: <ProfilePage /> },
      {
        path: '/trips/:tripId',
        element: <TripLayout />,
        children: [
          { index: true, element: <TripPage /> },
          { path: 'expenses', element: <ExpensesPage /> },
          { path: 'expenses/new', element: <NewExpensePage /> },
          { path: 'expenses/:expenseId', element: <ExpenseDetailPage /> },
          { path: 'expenses/:expenseId/edit', element: <EditExpensePage /> },
          { path: 'balances', element: <BalancesPage /> },
          { path: 'people', element: <PeoplePage /> },
          { path: 'rates', element: <RatesPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'data', element: <DataPage /> },
          { path: 'report', element: <ReportPage /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
