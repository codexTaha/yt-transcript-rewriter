'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Loader2, CheckCircle2, XCircle, AlertCircle, Download, Youtube } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { Job, JobVideo, TranscriptStatus, RewriteStatus } from '@/types';

function transcriptBadge(status: TranscriptStatus) {
  const map: Record<TranscriptStatus, JSX.Element> = {
    pending:    <Badge variant="outline">Pending</Badge>,
    processing: <Badge variant="default">Processing…</Badge>,
    done:       <Badge variant="success">Extracted</Badge>,
    failed:     <Badge variant="destructive">Failed</Badge>,
    skipped:    <Badge variant="secondary">No Captions</Badge>,
  };
  return map[status];
}

function rewriteBadge(status: RewriteStatus) {
  const map: Record<RewriteStatus, JSX.Element> = {
    not_started: <Badge variant="outline">-</Badge>,
    queued:      <Badge variant="default">Queued</Badge>,
    processing:  <Badge variant="default">Rewriting…</Badge>,
    done:        <Badge variant="success">Done</Badge>,
    failed:      <Badge variant="destructive">Failed</Badge>,
  };
  return map[status];
}

export function JobDetailClient({
  job: initialJob,
  initialVideos
}: {
  job: Job;
  initialVideos: JobVideo[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [job, setJob] = useState<Job>(initialJob);
  const [videos, setVideos] = useState<JobVideo[]>(initialVideos);
  const [prompt, setPrompt] = useState('');
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [pumping, setPumping] = useState(false);

  // Realtime: subscribe to job and job_videos changes
  useEffect(() => {
    const jobChannel = supabase
      .channel(`job-${job.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'jobs',
        filter: `id=eq.${job.id}`
      }, (payload) => {
        setJob(payload.new as Job);
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'job_videos',
        filter: `job_id=eq.${job.id}`
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setVideos(prev => [...prev, payload.new as JobVideo]);
        } else if (payload.eventType === 'UPDATE') {
          setVideos(prev => prev.map(v => v.id === payload.new.id ? payload.new as JobVideo : v));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(jobChannel); };
  }, [job.id]);

  // Client-side pump for extracting state
  useEffect(() => {
    if (job.status !== 'extracting' || pumping) return;
    let active = true;

    async function pump() {
      setPumping(true);
      while (active) {
        try {
          const res = await fetch(`/api/worker/pump/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: job.id })
          });
          const data = await res.json();
          if (!data.success || data.data.remaining === 0) break;
        } catch {
          break;
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      setPumping(false);
    }
    pump();
    return () => { active = false; };
  }, [job.status, job.id]);

  // Client-side pump for rewriting state
  useEffect(() => {
    if (job.status !== 'rewriting' && job.status !== 'queued_for_rewrite') return;
    let active = true;

    async function pump() {
      while (active) {
        try {
          const res = await fetch(`/api/worker/pump/rewrite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: job.id })
          });
          const data = await res.json();
          if (!data.success || data.data.remaining === 0) break;
        } catch {
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    pump();
    return () => { active = false; };
  }, [job.status, job.id]);

  async function handlePromptSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) { toast.error('Please enter a prompt.'); return; }
    setSubmittingPrompt(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_prompt: prompt })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      toast.success(`Rewriting ${data.data.queued_count} transcripts…`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit prompt';
      toast.error(message);
    } finally {
      setSubmittingPrompt(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/download`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      window.open(data.data.url, '_blank');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Download failed';
      toast.error(message);
    } finally {
      setDownloading(false);
    }
  }

  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const transcriptFailed = videos.filter(v => v.transcript_status === 'failed' || v.transcript_status === 'skipped').length;
  const rewriteDone = videos.filter(v => v.rewrite_status === 'done').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Youtube className="h-4 w-4" />
            <span className="capitalize">{job.source_type ?? 'source'}</span>
          </div>
          <h1 className="text-2xl font-bold">{job.source_name ?? 'Processing…'}</h1>
          <p className="text-xs text-muted-foreground mt-1 break-all">{job.source_url}</p>
        </div>
        <StatusIndicator status={job.status} />
      </div>

      {/* Stats bar */}
      {job.total_video_count > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Videos" value={job.total_video_count} />
          <StatCard label="Transcripts" value={`${transcriptDone} / ${job.total_video_count}`} />
          <StatCard label="Rewritten" value={`${rewriteDone} / ${transcriptDone}`} />
        </div>
      )}

      {/* Awaiting prompt */}
      {job.status === 'awaiting_prompt' && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-6">
          <h2 className="font-semibold mb-1">Enter your master prompt</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {transcriptDone} transcript{transcriptDone !== 1 ? 's' : ''} ready.
            {transcriptFailed > 0 && ` ${transcriptFailed} unavailable (will be skipped).`}
            {' '}This prompt will be applied to all successful transcripts.
          </p>
          <form onSubmit={handlePromptSubmit} className="space-y-3">
            <Textarea
              placeholder="e.g. Rewrite this YouTube transcript as a structured blog post with headers and key takeaways."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              maxLength={2000}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{prompt.length}/2000</span>
              <Button type="submit" loading={submittingPrompt}>
                Start Rewriting
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Download button */}
      {(job.status === 'completed' || job.status === 'completed_with_errors') && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-emerald-400">Job complete</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {rewriteDone} scripts rewritten.
                {job.status === 'completed_with_errors' && ' Some videos had errors — see table below.'}
              </p>
            </div>
            <Button onClick={handleDownload} loading={downloading}>
              <Download className="h-4 w-4 mr-2" />
              Download Bundle
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {job.status === 'failed' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-red-400">
          <div className="flex items-center gap-2 font-medium mb-1">
            <AlertCircle className="h-4 w-4" />
            Job failed
          </div>
          {job.error_message && <p className="text-xs">{job.error_message}</p>}
        </div>
      )}

      {/* Video table */}
      {videos.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-card">
            <h2 className="text-sm font-semibold">Videos ({videos.length})</h2>
          </div>
          <div className="divide-y divide-border">
            {videos.map((video) => (
              <div key={video.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-xs text-muted-foreground w-6 text-right shrink-0">
                  {video.discovery_position + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {video.video_title ?? video.video_id}
                  </div>
                  {video.transcript_word_count && (
                    <div className="text-xs text-muted-foreground">
                      {video.transcript_word_count.toLocaleString()} words
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {transcriptBadge(video.transcript_status)}
                  {rewriteBadge(video.rewrite_status)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const active = ['discovering', 'extracting', 'queued_for_rewrite', 'rewriting', 'building_export'].includes(status);
  return (
    <div className="flex items-center gap-2 text-sm">
      {active && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
      {status === 'completed' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
      {status === 'failed' && <XCircle className="h-4 w-4 text-red-400" />}
      <span className="text-muted-foreground capitalize">{status.replace(/_/g, ' ')}</span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
