'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, X, FileText, Trash2 } from 'lucide-react';

type Job = Record<string, unknown>;
type JobVideo = Record<string, unknown>;

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  created:               'Created',
  discovering:           'Discovering',
  extracting:            'Extracting',
  awaiting_prompt:       'Ready for Prompt',
  queued_for_rewrite:    'Queued for Rewrite',
  rewriting:             'Rewriting',
  building_export:       'Building Export',
  completed:             'Completed',
  completed_with_errors: 'Completed with Errors',
  failed:                'Failed',
  cancelled:             'Cancelled',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  created:               'secondary',
  discovering:           'default',
  extracting:            'default',
  awaiting_prompt:       'warning',
  queued_for_rewrite:    'default',
  rewriting:             'default',
  building_export:       'default',
  completed:             'success',
  completed_with_errors: 'warning',
  failed:                'destructive',
  cancelled:             'secondary',
};

const TRANSCRIPT_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  pending:    'secondary',
  processing: 'default',
  done:       'success',
  failed:     'destructive',
  skipped:    'secondary',
};

const REWRITE_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  not_started: 'secondary',
  queued:      'default',
  processing:  'default',
  done:        'success',
  failed:      'destructive',
};

const CANCELLABLE_STATUSES = [
  'created', 'discovering', 'extracting',
  'awaiting_prompt', 'queued_for_rewrite', 'rewriting', 'building_export',
];

// Status transitions the pump tells us about — used for optimistic UI updates
const PUMP_NEXT_STATUS: Record<string, string> = {
  awaiting_prompt: 'awaiting_prompt',
  building_export: 'building_export',
};

// ─── Transcript Modal ─────────────────────────────────────────────────────────

function TranscriptModal({
  jobId,
  video,
  onClose,
}: {
  jobId: string;
  video: JobVideo;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/transcript?video_id=${video.video_id as string}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.success) setText(data.data.text as string);
        else setError((data.error as string) ?? 'Failed to load transcript');
      })
      .catch(() => { if (!cancelled) setError('Network error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, video.video_id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const wordCount = typeof video.transcript_word_count === 'number' ? video.transcript_word_count as number : null;
  const language  = typeof video.transcript_language  === 'string' ? (video.transcript_language as string).toUpperCase() : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-foreground truncate">
              {(video.video_title as string) || (video.video_id as string)}
            </h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              {wordCount !== null && <span>{wordCount.toLocaleString()} words</span>}
              {language  !== null && <span>Language: {language}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={handleCopy} disabled={!text}>Copy</Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && error && (
            <p className="text-sm text-destructive py-8 text-center">{error}</p>
          )}
          {!loading && text && (
            <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function JobDetailClient({
  job: initialJob,
  initialVideos,
}: {
  job: Job;
  initialVideos: JobVideo[];
}) {
  const router = useRouter();

  const [job,    setJob]    = useState<Job>(initialJob);
  const [videos, setVideos] = useState<JobVideo[]>(initialVideos);

  // hydrated = we have a definitive video list from client-side fetch or realtime
  const [hydrated, setHydrated] = useState(initialVideos.length > 0);

  const [prompt,           setPrompt]           = useState('');
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [downloading,      setDownloading]      = useState(false);
  const [cancelling,       setCancelling]       = useState(false);
  const [deleting,         setDeleting]         = useState(false);
  const [viewingVideo,     setViewingVideo]     = useState<JobVideo | null>(null);

  // pumpRunning prevents concurrent pump loops for the same endpoint
  const pumpRunning = useRef<Record<string, boolean>>({});
  // statusRef mirrors job.status — readable synchronously inside async loops
  const statusRef = useRef<string>(initialJob.status as string);

  const jobId  = job.id     as string;
  const status = job.status as string;

  // Keep statusRef always in sync
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ── Mount fetch: always re-load from DB on client-side navigation ──────────
  // (SSR data may be stale if the user navigated here via next/link)
  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single()
      .then(({ data }) => { if (active && data) setJob(data as Job); });

    supabase
      .from('job_videos')
      .select('*')
      .eq('job_id', jobId)
      .order('discovery_position', { ascending: true })
      .then(({ data }) => {
        if (!active) return;
        if (data) {
          setVideos(data as JobVideo[]);
          setHydrated(true);
        }
      });

    return () => { active = false; };
  }, [jobId]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`job-detail-${jobId}`)
      // Job row updates
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` },
        payload => setJob(payload.new as Job)
      )
      // Video row changes
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload => {
          setVideos(prev => {
            if (prev.some(v => (v.id as string) === (payload.new.id as string))) return prev;
            return [...prev, payload.new as JobVideo];
          });
          // First INSERT proves videos exist — resolve the loading state
          setHydrated(true);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload =>
          setVideos(prev =>
            prev.map(v =>
              (v.id as string) === (payload.new.id as string) ? (payload.new as JobVideo) : v
            )
          )
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload =>
          setVideos(prev => prev.filter(v => (v.id as string) !== (payload.old.id as string)))
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [jobId]);

  // ── Pump loop ──────────────────────────────────────────────────────────────
  const pump = useCallback(async (endpoint: string) => {
    if (pumpRunning.current[endpoint]) return;
    pumpRunning.current[endpoint] = true;

    try {
      while (true) {
        const current = statusRef.current;

        // Hard stop conditions
        if (current === 'cancelled' || current === 'failed') break;
        if (endpoint.includes('extract') && current !== 'extracting') break;
        if (endpoint.includes('rewrite') && current !== 'rewriting') break;

        let data: { success: boolean; data?: { remaining?: number; advanced?: boolean; next_status?: string; waiting?: boolean } };

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobId }),
          });
          if (!res.ok) break;
          data = await res.json();
        } catch {
          break; // network error
        }

        // Server confirmed job advanced — optimistically update the UI immediately
        // so the badge and prompt box don't wait on a (potentially slow) realtime event
        if (data?.data?.advanced && data.data.next_status) {
          const nextStatus = data.data.next_status;
          statusRef.current = nextStatus; // update ref synchronously before setJob re-render
          setJob(prev => ({ ...prev, status: nextStatus }));
          break;
        }

        if (data?.data?.advanced) break; // advanced but no next_status hint

        const remaining = data?.data?.remaining ?? 0;

        // If we're in "waiting" mode (batch dispatched, some still processing),
        // keep polling but with a longer backoff to avoid hammering the DB
        if (data?.data?.waiting) {
          await new Promise<void>(r => setTimeout(r, 3000));
          continue;
        }

        if (remaining <= 0) break;
        await new Promise<void>(r => setTimeout(r, 2000));
      }
    } finally {
      pumpRunning.current[endpoint] = false;
    }
  }, [jobId]);

  // Auto-start pump when status becomes active
  useEffect(() => {
    if (status === 'extracting') pump('/api/worker/pump/extract');
    else if (status === 'rewriting') pump('/api/worker/pump/rewrite');
  }, [status, pump]);

  // ── Action handlers ────────────────────────────────────────────────────────

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
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success(`Queued ${(data.data.queued_count as number)} videos for rewriting`);
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
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      window.open(data.data.url as string, '_blank');
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
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job cancelled');
      statusRef.current = 'cancelled';
      setJob(prev => ({ ...prev, status: 'cancelled' }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Permanently delete this job and ALL its data? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job deleted');
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete job');
      setDeleting(false);
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────

  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const rewriteDone    = videos.filter(v => v.rewrite_status    === 'done').length;
  const totalVideos    = hydrated
    ? videos.length
    : ((job.total_video_count as number) || 0);
  const isCancellable  = CANCELLABLE_STATUSES.includes(status);
  const isActive       = ['discovering', 'extracting', 'rewriting', 'building_export'].includes(status);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {viewingVideo && (
        <TranscriptModal
          jobId={jobId}
          video={viewingVideo}
          onClose={() => setViewingVideo(null)}
        />
      )}

      <div className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 py-8">

          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div className="min-w-0 flex-1 pr-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
                <span>📋</span>
                <span className="capitalize">{job.source_type as string}</span>
              </div>
              <h1 className="text-2xl font-bold text-foreground truncate">
                {(job.source_name as string) || 'Loading...'}
              </h1>
              <p className="text-muted-foreground text-sm mt-1 truncate">
                {job.source_url as string}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'}>
                {isActive && <Loader2 className="h-3 w-3 animate-spin mr-1.5 inline" />}
                {STATUS_LABELS[status] ?? status}
              </Badge>
              {isCancellable && (
                <Button
                  variant="outline" size="sm"
                  onClick={handleCancel}
                  disabled={cancelling || deleting}
                  className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                >
                  {cancelling
                    ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Cancelling</>
                    : 'Cancel'}
                </Button>
              )}
              <Button
                variant="outline" size="sm"
                onClick={handleDelete}
                disabled={deleting || cancelling}
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                {deleting
                  ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Deleting</>
                  : <><Trash2 className="h-3.5 w-3.5 mr-1" />Delete</>}
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">
                {hydrated ? videos.length : ((job.total_video_count as number) || <Loader2 className="h-5 w-5 animate-spin inline" />)}
              </div>
              <div className="text-sm text-muted-foreground mt-1">Videos</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">
                {transcriptDone}
                <span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span>
              </div>
              <div className="text-sm text-muted-foreground mt-1">Transcripts</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">
                {rewriteDone}
                <span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span>
              </div>
              <div className="text-sm text-muted-foreground mt-1">Rewritten</div>
            </div>
          </div>

          {/* Cancelled notice */}
          {status === 'cancelled' && (
            <div className="bg-muted/40 border border-border rounded-lg p-5 mb-8">
              <p className="font-medium text-foreground">Job cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                {transcriptDone > 0
                  ? `${transcriptDone} transcript(s) were extracted before cancellation.`
                  : 'No transcripts were extracted.'}
              </p>
            </div>
          )}

          {/* Prompt box — only when status is confirmed awaiting_prompt AND we have transcripts */}
          {status === 'awaiting_prompt' && transcriptDone > 0 && (
            <div className="bg-card border border-border rounded-lg p-6 mb-8">
              <h2 className="text-lg font-semibold text-foreground mb-1">Enter your rewrite prompt</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Applied to all <strong>{transcriptDone}</strong> extracted transcript{transcriptDone !== 1 ? 's' : ''}.
              </p>
              <Textarea
                placeholder="e.g. Rewrite this YouTube transcript as a clean, engaging blog post. Remove filler words and timestamps. Use markdown headings."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="mb-4"
                rows={5}
              />
              <Button
                onClick={handleSubmitPrompt}
                disabled={submittingPrompt || !prompt.trim()}
              >
                {submittingPrompt
                  ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Submitting...</>
                  : `Rewrite ${transcriptDone} transcript${transcriptDone !== 1 ? 's' : ''}`}
              </Button>
            </div>
          )}

          {/* Download */}
          {(status === 'completed' || status === 'completed_with_errors') && (
            <div className="bg-card border border-border rounded-lg p-6 mb-8">
              <h2 className="text-lg font-semibold text-foreground mb-1">Export ready</h2>
              <p className="text-sm text-muted-foreground mb-4">
                {rewriteDone} video{rewriteDone !== 1 ? 's' : ''} rewritten successfully.
              </p>
              <Button onClick={handleDownload} disabled={downloading}>
                {downloading
                  ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating...</>
                  : '⬇ Download Markdown Bundle'}
              </Button>
            </div>
          )}

          {/* Failed */}
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
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold text-foreground">
                Videos ({hydrated ? videos.length : ((job.total_video_count as number) || '…')})
              </h2>
              {!hydrated && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            {!hydrated && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {hydrated && videos.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No videos found yet.
              </div>
            )}

            <div className="divide-y divide-border">
              {videos.map((video, index) => {
                const tStatus = video.transcript_status as string;
                const rStatus = video.rewrite_status   as string;
                const hasTx   = tStatus === 'done';

                return (
                  <div
                    key={video.id as string}
                    className="flex items-center gap-4 px-5 py-3 group"
                  >
                    <span className="text-muted-foreground text-sm w-6 text-right shrink-0">
                      {index + 1}
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        {(video.video_title as string) || (video.video_id as string)}
                      </p>
                      {hasTx && typeof video.transcript_word_count === 'number' && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(video.transcript_word_count as number).toLocaleString()} words
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'}
                        className="text-xs"
                      >
                        {tStatus === 'done'       ? '✓ Transcript'
                          : tStatus === 'failed'  ? '✗ No transcript'
                          : tStatus === 'skipped' ? '— Skipped'
                          : tStatus === 'processing' ? 'Extracting…'
                          : 'Pending'}
                      </Badge>

                      {rStatus && rStatus !== 'not_started' && (
                        <Badge
                          variant={REWRITE_VARIANTS[rStatus] ?? 'secondary'}
                          className="text-xs"
                        >
                          {rStatus === 'done' ? '✓ Rewritten' : rStatus}
                        </Badge>
                      )}

                      {hasTx && (
                        <button
                          onClick={() => setViewingVideo(video)}
                          title="View transcript"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          <FileText className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
