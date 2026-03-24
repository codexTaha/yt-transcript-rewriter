import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ApiResponse } from '@/types';

// Statuses that can be cancelled
const CANCELLABLE_STATUSES = [
  'created',
  'discovering',
  'extracting',
  'awaiting_prompt',
  'queued_for_rewrite',
  'rewriting',
  'building_export',
];

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Auth check — only the owner can cancel
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  // Fetch job and verify ownership
  const { data: job, error: fetchErr } = await admin
    .from('jobs')
    .select('id, status, user_id')
    .eq('id', id)
    .single();

  if (fetchErr || !job) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Job not found' }, { status: 404 });
  }

  if (job.user_id !== user.id) {
    return NextResponse.json<ApiResponse>({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  if (!CANCELLABLE_STATUSES.includes(job.status)) {
    return NextResponse.json<ApiResponse>({
      success: false,
      error: `Cannot cancel a job with status "${job.status}"`,
    }, { status: 422 });
  }

  // Mark the job as cancelled
  await admin
    .from('jobs')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id);

  // Stop any pending/processing video tasks so the pump won't pick them up again
  await admin
    .from('job_videos')
    .update({ transcript_status: 'skipped' })
    .eq('job_id', id)
    .in('transcript_status', ['pending', 'processing']);

  return NextResponse.json<ApiResponse>({ success: true, data: { cancelled: true } });
}
