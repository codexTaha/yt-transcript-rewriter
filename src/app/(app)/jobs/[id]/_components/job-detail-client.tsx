'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

type Job = Record<string, unknown>;
type JobVideo = Record<string, unknown>;

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  discovering: 'Discovering',
  extracting: 'Extracting',
  awaiting_prompt: 'Ready for Prompt',
  queued_for_rewrite: 'Queued',
  rewriting: 'Rewriting',
  building_export: 'Building Export',
  completed: 'Completed',
  completed_with_errors: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  created: 'secondary',
  discovering: 'default',
  extracting: 'default',
  awaiting_prompt: 'warning',
  queued_for_rewrite: 'default',
  rewriting: 'default',
  building_export: 'default',
  completed: 'success',
  completed_with_errors: 'warning',
  failed: 'destructive',
  cancelled: 'secondary',
};

const TRANSCRIPT_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  pending: 'secondary',
  processing: 'default',
  done: 'success',
  failed: 'destructive',
  skipped: 'secondary',
};

const REWRITE_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  not_started: 'secondary',
  queued: 'default',
  processing: 'default',
  done: 'success',
  failed: 'destructive',
};

const CANCELLABLE_STATUSES = [
  'created', 'discovering', 'extracting',
  'awaiting_prompt', 'queued_for_rewrite', 'rewriting', 'building_export',
];

export function JobDetailClient({
  job: initialJob,
  initialVideos,
}: {
  job: Job;
  initialVideos: JobVideo[];
}) {
  const router = useRouter();
  const [job, setJob] = useState<Job>(initialJob);
  const [videos, setVideos] = useState<JobVideo[]>(initialVideos);
  const [prompt, setPrompt] = useState('');
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const statusRef = useRef<string>(initialJob.status as string);

  const jobId = job.id as string;
  const status = job.status as string;

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`job-${jobId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'jobs',
        filter: `id=eq.${jobId}`,
      }, (payload) => {
        setJob(payload.new as Job);
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'job_videos',
        filter: `job_id=eq.${jobId}`,
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setVideos(prev => [...prev, payload.new as JobVideo]);
        } else if (payload.eventType === 'UPDATE') {
          setVideos(prev => prev.map(v =>
            (v.id as string) === (payload.new.id as string) ? payload.new as JobVideo : v
          ));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [jobId]);

  const pump = useCallback(async (endpoint: string) => {
    let remaining = 999;
    while (remaining > 0) {
      if (
        statusRef.current === 'cancelled' ||
        (endpoint.includes('extract') && statusRef.current !== 'extracting') ||
        (endpoint.includes('rewrite') && statusRef.current !== 'rewriting')
      ) break;

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: jobId }),
        });
        const data = await res.json();
        remaining = data?.data?.remaining ?? 0;
        if (data?.data?.advanced) break;
        if (remaining > 0) await new Promise(r => setTimeout(r, 2000));
      } catch {
        break;
      }
    }
  }, [jobId]);

  useEffect(() => {
    if (status === 'extracting') {
      pump('/api/worker/pump/extract');
    } else if (status === 'rewriting') {
      pump('/api/worker/pump/rewrite');
    }
  }, [status, pump]);

  const handleSubmitPrompt = async () => {
    if (!prompt.trim()) { toast.error('Please enter a prompt'); return; }
    setSubmittingPrompt(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_prompt: prompt }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      toast.success(`Queued ${data.data.queued_count} videos for rewriting`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit prompt');
    } finally {
      setSubmittingPrompt(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/download`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      window.open(data.data.url, '_blank');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Cancel this job? This cannot be undone.')) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      toast.success('Job cancelled');
      setJob(prev => ({ ...prev, status: 'cancelled' }));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Permanently delete this job and ALL its data (videos, transcripts, rewrites)? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      toast.success('Job deleted');
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete job');
      setDeleting(false);
    }
  };

  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const rewriteDone = videos.filter(v => v.rewrite_status === 'done').length;
  const totalVideos = videos.length || (job.total_video_count as number) || 0;
  const isCancellable = CANCELLABLE_STATUSES.includes(status);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
              <span>📋</span>
              <span className="capitalize">{job.source_type as string}</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground">
              {(job.source_name as string) || 'Loading...'}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">{job.source_url as string}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'}>
              {STATUS_LABELS[status] ?? status}
            </Badge>
            {isCancellable && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={cancelling || deleting}
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                {cancelling ? 'Cancelling...' : 'Cancel'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={deleting || cancelling}
              className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            >
              {deleting ? 'Deleting...' : '🗑 Delete Job'}
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="text-2xl font-bold text-foreground">{totalVideos}</div>
            <div className="text-sm text-muted-foreground mt-1">Videos</div>
          </div>
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="text-2xl font-bold text-foreground">
              {transcriptDone} / {totalVideos}
            </div>
            <div className="text-sm text-muted-foreground mt-1">Transcripts</div>
          </div>
          <div className="bg-card border border-border rounded-lg p-5">
            <div className="text-2xl font-bold text-foreground">
              {rewriteDone} / {totalVideos}
            </div>
            <div className="text-sm text-muted-foreground mt-1">Rewritten</div>
          </div>
        </div>

        {/* Cancelled state */}
        {status === 'cancelled' && (
          <div className="bg-muted/40 border border-border rounded-lg p-5 mb-8">
            <p className="font-medium text-foreground">Job cancelled</p>
            <p className="text-sm text-muted-foreground mt-1">
              This job was cancelled. {transcriptDone > 0
                ? `${transcriptDone} transcript(s) were extracted before cancellation.`
                : 'No transcripts were extracted.'}
            </p>
          </div>
        )}

        {/* Prompt box */}
        {status === 'awaiting_prompt' && (
          <div className="bg-card border border-border rounded-lg p-6 mb-8">
            <h2 className="text-lg font-semibold text-foreground mb-1">Enter your rewrite prompt</h2>
            <p className="text-sm text-muted-foreground mb-4">
              This single prompt will be applied to all {transcriptDone} transcripts.
            </p>
            <Textarea
              placeholder="e.g. Rewrite this YouTube transcript as a clean, engaging blog post. Remove filler words and timestamps. Use markdown headings."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              className="mb-4"
              rows={5}
            />
            <Button onClick={handleSubmitPrompt} disabled={submittingPrompt}>
              {submittingPrompt ? 'Submitting...' : `Rewrite ${transcriptDone} transcripts`}
            </Button>
          </div>
        )}

        {/* Download button */}
        {(status === 'completed' || status === 'completed_with_errors') && (
          <div className="bg-card border border-border rounded-lg p-6 mb-8">
            <h2 className="text-lg font-semibold text-foreground mb-1">Export ready</h2>
            <p className="text-sm text-muted-foreground mb-4">
              {rewriteDone} videos rewritten successfully.
            </p>
            <Button onClick={handleDownload} disabled={downloading}>
              {downloading ? 'Generating link...' : '⬇ Download Markdown Bundle'}
            </Button>
          </div>
        )}

        {/* Error state */}
        {status === 'failed' && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-5 mb-8">
            <p className="text-destructive font-medium">Job failed</p>
            <p className="text-sm text-muted-foreground mt-1">
              {(job.error_message as string) || 'An unknown error occurred.'}
            </p>
          </div>
        )}

        {/* Video list */}
        <div className="bg-card border border-border rounded-lg">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="font-semibold text-foreground">Videos ({totalVideos})</h2>
          </div>
          <div className="divide-y divide-border">
            {videos.map((video, index) => {
              const tStatus = video.transcript_status as string;
              const rStatus = video.rewrite_status as string;
              return (
                <div key={video.id as string} className="flex items-center gap-4 px-5 py-3">
                  <span className="text-muted-foreground text-sm w-6 text-right">{index + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">
                      {(video.video_title as string) || video.video_id as string}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'} className="text-xs">
                      {tStatus === 'done'
                        ? '✓ Transcript'
                        : tStatus === 'failed'
                        ? '✗ No transcript'
                        : tStatus === 'skipped'
                        ? '— Skipped'
                        : tStatus}
                    </Badge>
                    {rStatus !== 'not_started' && (
                      <Badge variant={REWRITE_VARIANTS[rStatus] ?? 'secondary'} className="text-xs">
                        {rStatus === 'done' ? '✓ Rewritten' : rStatus}
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
