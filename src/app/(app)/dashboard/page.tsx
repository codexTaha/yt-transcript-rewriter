'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Plus, Youtube, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import type { Job, JobStatus } from '@/types';

function statusBadge(status: JobStatus | string) {
  const map: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' }> = {
    created:               { label: 'Created',         variant: 'outline' },
    discovering:           { label: 'Discovering',     variant: 'default' },
    extracting:            { label: 'Extracting',      variant: 'default' },
    awaiting_prompt:       { label: 'Needs Prompt',    variant: 'warning' },
    queued_for_rewrite:    { label: 'Queued',          variant: 'default' },
    rewriting:             { label: 'Rewriting',       variant: 'default' },
    building_export:       { label: 'Building',        variant: 'default' },
    completed:             { label: 'Completed',       variant: 'success' },
    completed_with_errors: { label: 'Done w/ Errors',  variant: 'warning' },
    failed:                { label: 'Failed',          variant: 'destructive' },
    cancelled:             { label: 'Cancelled',       variant: 'secondary' },
  };
  const s = map[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setJobs((data as Job[]) ?? []);
        setLoading(false);
      });
  }, []);

  const handleDelete = async (e: React.MouseEvent, jobId: string) => {
    e.preventDefault(); // prevent Link navigation
    e.stopPropagation();
    if (!confirm('Permanently delete this job and all its data? This cannot be undone.')) return;

    setDeletingId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setJobs(prev => prev.filter(j => j.id !== jobId));
      toast.success('Job deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete job');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-muted-foreground text-sm">Loading jobs...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">My Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">Each job processes one YouTube source with one AI prompt.</p>
        </div>
        <Link href="/jobs/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Job
          </Button>
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-16 text-center">
          <Youtube className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-semibold mb-2">No jobs yet</h3>
          <p className="text-sm text-muted-foreground mb-6">Create your first job by pasting a YouTube URL.</p>
          <Link href="/jobs/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create first job
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Link key={job.id} href={`/jobs/${job.id}`}>
              <div className="rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-colors cursor-pointer">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <Youtube className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {job.source_name ?? job.source_url}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                        <span className="capitalize">{job.source_type ?? 'unknown'}</span>
                        {job.total_video_count > 0 && (
                          <span>· {job.total_video_count} videos</span>
                        )}
                        <span>· {new Date(job.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {statusBadge(job.status)}
                    <button
                      onClick={(e) => handleDelete(e, job.id)}
                      disabled={deletingId === job.id}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                      title="Delete job"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
