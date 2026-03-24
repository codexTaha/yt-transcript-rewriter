import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth check — only the owner can delete
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch job and verify ownership
  const { data: job, error: fetchErr } = await admin
    .from('jobs')
    .select('id, user_id')
    .eq('id', id)
    .single();

  if (fetchErr || !job) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
  }

  if (job.user_id !== user.id) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  // 1. Delete storage files — list and remove all objects under this job's prefix
  const { data: storageFiles } = await admin
    .storage
    .from('transcripts')
    .list(id, { limit: 1000 });

  if (storageFiles && storageFiles.length > 0) {
    // Each folder under job id is a video_id, need to list files inside each
    for (const folder of storageFiles) {
      const { data: innerFiles } = await admin
        .storage
        .from('transcripts')
        .list(`${id}/${folder.name}`, { limit: 1000 });

      if (innerFiles && innerFiles.length > 0) {
        const paths = innerFiles.map(f => `${id}/${folder.name}/${f.name}`);
        await admin.storage.from('transcripts').remove(paths);
      }
    }
  }

  // 2. Delete job_videos rows (cascade should handle this, but be explicit)
  await admin.from('job_videos').delete().eq('job_id', id);

  // 3. Delete the job itself
  const { error: deleteErr } = await admin.from('jobs').delete().eq('id', id);

  if (deleteErr) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `Delete failed: ${deleteErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json<ApiResponse>({ success: true, data: { deleted: true } });
}
