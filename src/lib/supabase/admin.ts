import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Admin client using the service role key.
 * ONLY used in server-side API routes and workers.
 * NEVER import this in client components.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}
