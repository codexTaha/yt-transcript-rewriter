import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { LogOut, Youtube } from 'lucide-react';

export async function Navbar() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold text-foreground hover:text-primary transition-colors">
          <Youtube className="h-5 w-5 text-primary" />
          <span>YT Rewriter</span>
        </Link>

        <nav className="flex items-center gap-4">
          {user ? (
            <>
              <Link
                href="/dashboard"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Dashboard
              </Link>
              <form action="/api/auth/signout" method="POST">
                <button
                  type="submit"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/auth"
              className="text-sm text-primary hover:text-primary/80 transition-colors font-medium"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
