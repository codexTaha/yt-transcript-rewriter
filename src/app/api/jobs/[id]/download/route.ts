import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { ApiResponse } from '@/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const admin = createAdminClient();

  try {
    const userClient = await createClient();
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { data: job, error: jobError } = await admin
      .from('jobs')
      .select('export_storage_path, export_ready, user_id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (jobError || !job) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
    }

    if (!job.export_ready || !job.export_storage_path) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Export not ready yet' }, { status: 400 });
    }

    // Generate signed URL valid for 1 hour
    const { data: signedUrl, error: urlError } = await admin
      .storage
      .from('exports')
      .createSignedUrl(job.export_storage_path.replace('exports/', ''), 3600);

    if (urlError || !signedUrl) {
      return NextResponse.json<ApiResponse>({ success: false, error: 'Failed to generate download URL' }, { status: 500 });
    }

    return NextResponse.json<ApiResponse>({ success: true, data: { url: signedUrl.signedUrl } });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed';
    return NextResponse.json<ApiResponse>({ success: false, error: message }, { status: 500 });
  }
}
