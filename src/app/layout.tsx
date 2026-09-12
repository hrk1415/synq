import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Providers from '@/components/layout/Providers';
import AppLayout from '@/components/layout/AppLayout';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Synq — AI-Powered Deal OS',
  description: 'Negotiate. Protect. Escrow. Pay. Synq turns agreements into intelligent, protected, executable transactions.',
  icons: {
    icon: [
      { url: '/synq-favicon-round.png' },
      { url: '/favicon.ico' },
    ],
    shortcut: '/synq-favicon-round.png',
    apple: '/synq-favicon-round.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Providers>
          <AppLayout>
            {children}
          </AppLayout>
        </Providers>
      </body>
    </html>
  );
}
