'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Youtube, Moon, Sun, LayoutDashboard, LogIn } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';

export function Navbar({ isLoggedIn }: { isLoggedIn: boolean }) {
  const { theme, toggle } = useTheme();
  const router = useRouter();

  const handleSignOut = async () => {
    const res = await fetch('/api/auth/signout', { method: 'POST' });
    if (res.ok) {
      router.push('/auth');
      router.refresh();
    }
  };

  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-foreground hover:text-primary transition-colors"
        >
          <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
            <Youtube className="h-4 w-4 text-primary" />
          </div>
          <span>YT Rewriter</span>
        </Link>

        {/* Right nav */}
        <nav className="flex items-center gap-2">
          {/* Dark / Light toggle */}
          <button
            onClick={toggle}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="h-9 w-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          {isLoggedIn ? (
            <>
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-all"
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                Dashboard
              </Link>
              <button
                onClick={handleSignOut}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-border bg-card text-sm font-medium text-muted-foreground hover:text-destructive hover:border-destructive/50 hover:bg-destructive/10 transition-all"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link
              href="/auth"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-sm"
            >
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
