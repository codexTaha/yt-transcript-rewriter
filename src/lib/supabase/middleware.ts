import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // CRITICAL: do NOT re-create supabaseResponse here.
          // Re-creating it drops cookies set by earlier middleware.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Re-create response only to attach cookies to the outgoing response
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            // Persist session cookies for the entire browser session (until tab close)
            const opts = {
              ...options,
              // Remove maxAge/expires so cookie becomes session-scoped
              maxAge: undefined,
              expires: undefined,
              sameSite: 'lax' as const,
              httpOnly: true,
              path: '/',
            };
            supabaseResponse.cookies.set(name, value, opts);
          });
        },
      },
    }
  );

  // Refresh the session token if it is close to expiry
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Protect /dashboard and /jobs routes
  const isProtected =
    request.nextUrl.pathname.startsWith('/dashboard') ||
    request.nextUrl.pathname.startsWith('/jobs');

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
