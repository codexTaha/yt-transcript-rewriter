import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'YT Transcript Rewriter',
  description: 'Extract YouTube transcripts and rewrite them with AI — bulk, fast, downloadable.',
  keywords: ['youtube', 'transcript', 'AI rewriter', 'bulk', 'content creation'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'hsl(224 71% 6%)',
              border: '1px solid hsl(216 34% 17%)',
              color: 'hsl(213 31% 91%)'
            }
          }}
        />
      </body>
    </html>
  );
}
