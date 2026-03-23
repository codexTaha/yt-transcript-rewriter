import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { JobDetailClient } from './_components/job-detail-client';

export default async function JobDetailPage({ params }: { params: { id: string } }) {
  const supabase = await createClient();

  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', params.id)
    .single();

  if (error || !job) notFound();

  const { data: videos } = await supabase
    .from('job_videos')
    .select('*')
    .eq('job_id', params.id)
    .order('discovery_position', { ascending: true });

  return <JobDetailClient job={job} initialVideos={videos ?? []} />;
}
