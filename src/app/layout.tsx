import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Sidebar from '@/components/layout/Sidebar';
import Providers from '@/components/layout/Providers';
import WalletStatus from '@/components/layout/WalletStatus';
import EmailBindModal from '@/components/shared/EmailBindModal';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Synq — AI-Powered Deal OS',
  description: 'Negotiate. Protect. Escrow. Pay. Synq turns agreements into intelligent, protected, executable transactions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Providers>
          <Sidebar />
          <EmailBindModal />
          <div className="fixed top-4 right-4 z-30">
            <WalletStatus />
          </div>
          <main className="lg:pl-[240px] min-h-screen transition-all duration-300">
            <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 pt-20 lg:pt-8">
              {children}
            </div>
          </main>
        </Providers>
      </body>
    </html>
  );
}
