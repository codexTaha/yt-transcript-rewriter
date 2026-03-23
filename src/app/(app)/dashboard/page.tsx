import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Plus, Youtube, Clock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Job, JobStatus } from '@/types';

function statusBadge(status: JobStatus) {
  const map: Record<JobStatus, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' }> = {
    created:              { label: 'Created',           variant: 'outline' },
    discovering:          { label: 'Discovering',       variant: 'default' },
    extracting:           { label: 'Extracting',        variant: 'default' },
    awaiting_prompt:      { label: 'Needs Prompt',      variant: 'warning' },
    queued_for_rewrite:   { label: 'Queued',            variant: 'default' },
    rewriting:            { label: 'Rewriting',         variant: 'default' },
    building_export:      { label: 'Building',          variant: 'default' },
    completed:            { label: 'Completed',         variant: 'success' },
    completed_with_errors:{ label: 'Done w/ Errors',    variant: 'warning' },
    failed:               { label: 'Failed',            variant: 'destructive' },
  };
  const s = map[status] ?? { label: status, variant: 'outline' };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

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

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive mb-6">
          Failed to load jobs: {error.message}
        </div>
      )}

      {!jobs || jobs.length === 0 ? (
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
          {(jobs as Job[]).map((job) => (
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
