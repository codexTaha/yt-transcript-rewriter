import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/theme-provider';
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
        <ThemeProvider>
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              classNames: {
                toast: 'bg-card border border-border text-foreground',
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
