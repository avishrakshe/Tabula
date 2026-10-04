import type { Metadata } from 'next'
import { Shell } from '@/components/dashboard/Shell'
import { TabulaProvider } from '@/lib/data/provider'

export const metadata: Metadata = {
  title: 'Tabula dashboard',
  description:
    'Live agent payments: vouchers, agents, channels and float, ledger, reconciliation, vendors, policies.',
}

export default function DashboardLayout({ children }: LayoutProps<'/app'>) {
  return (
    <TabulaProvider>
      <Shell>{children}</Shell>
    </TabulaProvider>
  )
}
