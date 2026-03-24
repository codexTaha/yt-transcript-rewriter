'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, X, FileText, Trash2, Download, Pencil } from 'lucide-react';

type Job = Record<string, unknown>;
type JobVideo = Record<string, unknown>;

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

// Every status that is NOT terminal — heartbeat runs while any of these is current.
const ACTIVE_STATUSES = new Set([
  'created', 'discovering', 'extracting',
  'awaiting_prompt',
  'queued_for_rewrite', 'rewriting', 'building_export',
]);

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

// Pump drives workers but NEVER owns status transitions — DB is the only truth.
const PUMP_INTERVAL_MS  = 2000;   // how often the pump calls the worker endpoint
const HEARTBEAT_MS      = 2000;   // how often we read DB while job is active

// ─── Transcript Viewer Modal ──────────────────────────────────────────────────

function TranscriptModal({ jobId, video, onClose }: { jobId: string; video: JobVideo; onClose: () => void }) {
  const [text,    setText]    = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/transcript?video_id=${video.video_id as string}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d.success) setText(d.data.text as string); else setError((d.error as string) ?? 'Failed to load transcript'); } })
      .catch(() => { if (!cancelled) setError('Network error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId, video.video_id]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const wordCount = typeof video.transcript_word_count === 'number' ? video.transcript_word_count as number : null;
  const language  = typeof video.transcript_language  === 'string' ? (video.transcript_language as string).toUpperCase() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-foreground truncate">{(video.video_title as string) || (video.video_id as string)}</h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              {wordCount !== null && <span>{wordCount.toLocaleString()} words</span>}
              {language  !== null && <span>Language: {language}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => { if (text) { navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); } }} disabled={!text}>Copy</Button>
            <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {loading && <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
          {!loading && error && <p className="text-sm text-destructive py-8 text-center">{error}</p>}
          {!loading && text  && <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">{text}</pre>}
        </div>
      </div>
    </div>
  );
}

// ─── Completion Choice Modal ──────────────────────────────────────────────────

function CompletionModal({ transcriptCount, onRewrite, onExportRaw, onDismiss, exportingRaw }: {
  transcriptCount: number; onRewrite: () => void; onExportRaw: () => void; onDismiss: () => void; exportingRaw: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Extraction complete ✅</h2>
            <p className="text-sm text-muted-foreground mt-1"><strong>{transcriptCount}</strong> transcript{transcriptCount !== 1 ? 's' : ''} extracted successfully. What would you like to do next?</p>
          </div>
          <button onClick={onDismiss} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-6 pb-6 flex flex-col gap-3">
          <button onClick={onRewrite} className="w-full flex items-start gap-4 p-4 rounded-lg border border-border bg-background hover:border-primary/60 hover:bg-primary/5 transition-all text-left group">
            <div className="mt-0.5 p-2 rounded-md bg-primary/10 text-primary shrink-0"><Pencil className="h-4 w-4" /></div>
            <div>
              <p className="font-medium text-foreground group-hover:text-primary transition-colors">Rewrite with AI</p>
              <p className="text-sm text-muted-foreground mt-0.5">Enter a prompt and let AI rewrite all transcripts. Download as a Markdown bundle when done.</p>
            </div>
          </button>
          <button onClick={onExportRaw} disabled={exportingRaw} className="w-full flex items-start gap-4 p-4 rounded-lg border border-border bg-background hover:border-primary/60 hover:bg-primary/5 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
            <div className="mt-0.5 p-2 rounded-md bg-muted text-muted-foreground shrink-0">{exportingRaw ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</div>
            <div>
              <p className="font-medium text-foreground group-hover:text-primary transition-colors">Export raw transcripts</p>
              <p className="text-sm text-muted-foreground mt-0.5">Download all transcripts as a single <code className="font-mono text-xs">.txt</code> file, separated by video title and a divider.</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Rewrite Prompt Modal ─────────────────────────────────────────────────────

function RewritePromptModal({ transcriptCount, onSubmit, onBack, submitting }: {
  transcriptCount: number; onSubmit: (prompt: string) => void; onBack: () => void; submitting: boolean;
}) {
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onBack(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onBack, submitting]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">AI Rewrite Prompt</h2>
            <p className="text-sm text-muted-foreground mt-0.5">This prompt is applied to all <strong>{transcriptCount}</strong> transcript{transcriptCount !== 1 ? 's' : ''}.</p>
          </div>
          <button onClick={onBack} disabled={submitting} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-6 pb-6">
          <Textarea autoFocus placeholder="e.g. Rewrite this YouTube transcript as a clean, engaging blog post. Remove filler words and timestamps. Use markdown headings where appropriate." value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} className="mb-4 resize-none" disabled={submitting} />
          <div className="flex items-center gap-3 justify-end">
            <Button variant="outline" onClick={onBack} disabled={submitting}>← Back</Button>
            <Button onClick={() => onSubmit(prompt)} disabled={submitting || !prompt.trim()}>
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Submitting…</> : `Rewrite ${transcriptCount} transcript${transcriptCount !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ModalState = 'none' | 'completion' | 'prompt';

export function JobDetailClient({ job: initialJob, initialVideos }: { job: Job; initialVideos: JobVideo[] }) {
  const router = useRouter();

  // ── Pure React state — DB is the ONLY source of truth for job/status ──────
  const [job,      setJob]      = useState<Job>(initialJob);
  const [videos,   setVideos]   = useState<JobVideo[]>(initialVideos);
  const [hydrated, setHydrated] = useState(initialVideos.length > 0);
  const [modal,    setModal]    = useState<ModalState>('none');

  // Stable refs used inside callbacks/intervals — never drive render directly
  const jobRef           = useRef<Job>(initialJob);
  const videosRef        = useRef<JobVideo[]>(initialVideos);
  const completionShown  = useRef<boolean>(false);
  const pumpRunning      = useRef<Record<string, boolean>>({});
  const heartbeatLock    = useRef<boolean>(false);   // prevent overlapping DB reads

  const jobId = initialJob.id as string;

  // ── Central status handler — called by EVERY path that learns of a new status
  // (heartbeat, Realtime, pump response, action handlers).
  // This is the single place that decides whether to show the completion modal.
  const handleStatusChange = useCallback((newJob: Job) => {
    const prev   = jobRef.current.status as string;
    const next   = newJob.status         as string;
    jobRef.current = newJob;
    setJob(newJob);

    if (next === prev) return; // no-op if same

    // Show completion modal exactly once when extraction finishes
    if (next === 'awaiting_prompt' && !completionShown.current) {
      completionShown.current = true;
      setModal('completion');
    }
  }, []);

  // ── Read full job + videos from DB and apply ───────────────────────────────
  const syncFromDB = useCallback(async () => {
    if (heartbeatLock.current) return;
    heartbeatLock.current = true;
    try {
      const supabase = createClient();
      const [{ data: jobData }, { data: videoData }] = await Promise.all([
        supabase.from('jobs').select('*').eq('id', jobId).single(),
        supabase.from('job_videos').select('*').eq('job_id', jobId).order('discovery_position', { ascending: true }),
      ]);
      if (jobData)   handleStatusChange(jobData as Job);
      if (videoData) {
        videosRef.current = videoData as JobVideo[];
        setVideos(videoData as JobVideo[]);
        setHydrated(true);
      }
    } catch { /* ignore transient errors — next tick will retry */ }
    finally { heartbeatLock.current = false; }
  }, [jobId, handleStatusChange]);

  // ── Heartbeat: polls DB every HEARTBEAT_MS while job is active ────────────
  // This is the guaranteed safety net. It runs unconditionally — no stale refs,
  // no pump state, no Realtime dependency. Tab visibility triggers immediate poll.
  useEffect(() => {
    // Immediately sync on mount to fix SSR staleness
    syncFromDB();

    const iv = setInterval(() => {
      const s = jobRef.current.status as string;
      if (TERMINAL_STATUSES.has(s)) {
        clearInterval(iv);
        return;
      }
      syncFromDB();
    }, HEARTBEAT_MS);

    // When tab becomes visible again, poll immediately
    const onVisible = () => {
      if (!TERMINAL_STATUSES.has(jobRef.current.status as string)) syncFromDB();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Realtime: bonus fast path on top of heartbeat ─────────────────────────
  // If Realtime fires we get near-instant updates. If it drops, heartbeat catches it.
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase
      .channel(`job-detail-rt-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` },
        payload => handleStatusChange(payload.new as Job)
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload => {
          setVideos(prev => {
            const incoming = payload.new as JobVideo;
            const next = prev.some(v => (v.id as string) === (incoming.id as string))
              ? prev.map(v => (v.id as string) === (incoming.id as string) ? incoming : v)
              : [...prev, incoming];
            videosRef.current = next;
            return next;
          });
          setHydrated(true);
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload => {
          setVideos(prev => {
            const incoming = payload.new as JobVideo;
            const next = prev.some(v => (v.id as string) === (incoming.id as string))
              ? prev.map(v => (v.id as string) === (incoming.id as string) ? incoming : v)
              : [...prev, incoming];
            videosRef.current = next;
            return next;
          });
          setHydrated(true);
        }
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` },
        payload => {
          setVideos(prev => {
            const next = prev.filter(v => (v.id as string) !== (payload.old.id as string));
            videosRef.current = next;
            return next;
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Worker pump — drives server-side workers, does NOT own status ─────────
  // It just keeps calling the worker endpoint while the job is in the right
  // state. Status comes from the heartbeat/Realtime, not from pump responses.
  const pump = useCallback(async (endpoint: string, validStatuses: string[]) => {
    if (pumpRunning.current[endpoint]) return;
    pumpRunning.current[endpoint] = true;
    try {
      while (true) {
        const s = jobRef.current.status as string;
        if (!validStatuses.includes(s)) break; // heartbeat already moved us on

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobId }),
          });
          if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
          const resp = await res.json() as { data?: { remaining?: number; waiting?: boolean; advanced?: boolean } };

          // Worker says it has advanced the job — sync DB immediately
          // (don't wait for the next heartbeat tick)
          if (resp?.data?.advanced) {
            await syncFromDB();
            break;
          }
          if (resp?.data?.waiting)              { await new Promise(r => setTimeout(r, 3000)); continue; }
          if ((resp?.data?.remaining ?? 0) <= 0) {
            // Nothing left — sync DB to pick up any status advance,
            // then exit pump (heartbeat will continue watching)
            await syncFromDB();
            break;
          }
        } catch {
          // Network/timeout — sync DB immediately in case server already advanced
          await syncFromDB();
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        await new Promise(r => setTimeout(r, PUMP_INTERVAL_MS));
      }
    } finally {
      pumpRunning.current[endpoint] = false;
    }
  }, [jobId, syncFromDB]);

  // ── Start pumps when status needs it ──────────────────────────────────────
  const startPumpsForStatus = useCallback((s: string) => {
    if (s === 'extracting')
      pump('/api/worker/pump/extract', ['extracting']);
    else if (s === 'queued_for_rewrite' || s === 'rewriting')
      pump('/api/worker/pump/rewrite', ['queued_for_rewrite', 'rewriting']);
  }, [pump]);

  // Boot pumps on mount for jobs already in progress
  useEffect(() => {
    startPumpsForStatus(initialJob.status as string);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Also start pump whenever Realtime or heartbeat surfaces a new active status
  const prevStatusRef = useRef<string>(initialJob.status as string);
  useEffect(() => {
    const s = job.status as string;
    if (s !== prevStatusRef.current) {
      prevStatusRef.current = s;
      startPumpsForStatus(s);
    }
  }, [job.status, startPumpsForStatus]);

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleSubmitPrompt = async (promptText: string) => {
    try {
      const res  = await fetch(`/api/jobs/${jobId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_prompt: promptText }),
      });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success(`Queued ${data.data.queued_count as number} video${(data.data.queued_count as number) !== 1 ? 's' : ''} for rewriting`);
      setModal('none');
      // Immediately sync DB — don't wait for next heartbeat tick
      await syncFromDB();
      pump('/api/worker/pump/rewrite', ['queued_for_rewrite', 'rewriting']);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit prompt');
    }
  };

  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const wrappedSubmitPrompt = async (p: string) => {
    setSubmittingPrompt(true);
    await handleSubmitPrompt(p);
    setSubmittingPrompt(false);
  };

  const [exportingRaw, setExportingRaw] = useState(false);
  const handleExportRaw = async () => {
    if (exportingRaw) return;
    setExportingRaw(true); setModal('none');
    try {
      const res = await fetch(`/api/jobs/${jobId}/export-transcripts`);
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `transcripts-${jobId.slice(0, 8)}.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      toast.success('Transcripts downloaded');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Export failed'); }
    finally { setExportingRaw(false); }
  };

  const [downloading, setDownloading] = useState(false);
  const handleDownloadRewritten = async () => {
    setDownloading(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/download`);
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      window.open(data.data.url as string, '_blank');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Download failed'); }
    finally { setDownloading(false); }
  };

  const [cancelling, setCancelling] = useState(false);
  const handleCancel = async () => {
    if (!confirm('Cancel this job? This cannot be undone.')) return;
    setCancelling(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job cancelled');
      setModal('none');
      await syncFromDB();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to cancel'); }
    finally { setCancelling(false); }
  };

  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!confirm('Permanently delete this job and ALL its data? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job deleted'); router.push('/dashboard');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to delete'); setDeleting(false); }
  };

  const [viewingVideo, setViewingVideo] = useState<JobVideo | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────
  const status         = job.status as string;
  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const rewriteDone    = videos.filter(v => v.rewrite_status    === 'done').length;
  const totalVideos    = hydrated ? videos.length : ((job.total_video_count as number) || 0);
  const isCancellable  = CANCELLABLE_STATUSES.includes(status);
  const isActive       = ACTIVE_STATUSES.has(status);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {viewingVideo && <TranscriptModal jobId={jobId} video={viewingVideo} onClose={() => setViewingVideo(null)} />}

      {modal === 'completion' && (
        <CompletionModal
          transcriptCount={transcriptDone}
          onRewrite={() => setModal('prompt')}
          onExportRaw={handleExportRaw}
          onDismiss={() => setModal('none')}
          exportingRaw={exportingRaw}
        />
      )}

      {modal === 'prompt' && (
        <RewritePromptModal
          transcriptCount={transcriptDone}
          onSubmit={wrappedSubmitPrompt}
          onBack={() => setModal('completion')}
          submitting={submittingPrompt}
        />
      )}

      <div className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 py-8">

          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div className="min-w-0 flex-1 pr-4">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
                <span>📋</span><span className="capitalize">{job.source_type as string}</span>
              </div>
              <h1 className="text-2xl font-bold text-foreground truncate">{(job.source_name as string) || 'Loading…'}</h1>
              <p className="text-muted-foreground text-sm mt-1 truncate">{job.source_url as string}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'}>
                {isActive && <Loader2 className="h-3 w-3 animate-spin mr-1.5 inline" />}
                {STATUS_LABELS[status] ?? status}
              </Badge>

              {status === 'awaiting_prompt' && modal === 'none' && transcriptDone > 0 && (
                <Button variant="outline" size="sm" onClick={() => {
                  completionShown.current = false;
                  if (!completionShown.current) { completionShown.current = true; setModal('completion'); }
                }}>
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />What&apos;s next?
                </Button>
              )}

              {isCancellable && (
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={cancelling || deleting} className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive">
                  {cancelling ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Cancelling</> : 'Cancel'}
                </Button>
              )}

              <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleting || cancelling} className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive">
                {deleting ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Deleting</> : <><Trash2 className="h-3.5 w-3.5 mr-1" />Delete</>}
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">{hydrated ? videos.length : ((job.total_video_count as number) || <Loader2 className="h-5 w-5 animate-spin inline" />)}</div>
              <div className="text-sm text-muted-foreground mt-1">Videos</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">{transcriptDone}<span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span></div>
              <div className="text-sm text-muted-foreground mt-1">Transcripts</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-2xl font-bold text-foreground">{rewriteDone}<span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span></div>
              <div className="text-sm text-muted-foreground mt-1">Rewritten</div>
            </div>
          </div>

          {/* Cancelled */}
          {status === 'cancelled' && (
            <div className="bg-muted/40 border border-border rounded-lg p-5 mb-8">
              <p className="font-medium text-foreground">Job cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">{transcriptDone > 0 ? `${transcriptDone} transcript(s) were extracted before cancellation. You can still export them.` : 'No transcripts were extracted.'}</p>
              {transcriptDone > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Export transcripts</>}
                </Button>
              )}
            </div>
          )}

          {/* Completed */}
          {(status === 'completed' || status === 'completed_with_errors') && (
            <div className="bg-card border border-border rounded-lg p-6 mb-8">
              <h2 className="text-lg font-semibold text-foreground mb-1">Export ready</h2>
              <p className="text-sm text-muted-foreground mb-4">
                {rewriteDone} video{rewriteDone !== 1 ? 's' : ''} rewritten successfully.
                {status === 'completed_with_errors' && <span className="text-warning ml-1">Some videos failed — see details below.</span>}
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <Button onClick={handleDownloadRewritten} disabled={downloading}>
                  {downloading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Generating…</> : '⬇ Download Markdown Bundle'}
                </Button>
                <Button variant="outline" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Preparing…</> : <><Download className="h-4 w-4 mr-2" />Export raw transcripts</>}
                </Button>
              </div>
            </div>
          )}

          {/* Failed */}
          {status === 'failed' && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-5 mb-8">
              <p className="text-destructive font-medium">Job failed</p>
              <p className="text-sm text-muted-foreground mt-1">{(job.error_message as string) || 'An unknown error occurred.'}</p>
              {transcriptDone > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Export transcripts anyway</>}
                </Button>
              )}
            </div>
          )}

          {/* Video list */}
          <div className="bg-card border border-border rounded-lg">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold text-foreground">Videos ({hydrated ? videos.length : ((job.total_video_count as number) || '…')})</h2>
              {!hydrated && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            {!hydrated && <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
            {hydrated && videos.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">No videos found yet.</div>}
            <div className="divide-y divide-border">
              {videos.map((video, index) => {
                const tStatus = video.transcript_status as string;
                const rStatus = video.rewrite_status   as string;
                const hasTx   = tStatus === 'done';
                const txError = video.transcript_error as string | null;
                const rwError = video.rewrite_error    as string | null;
                return (
                  <div key={video.id as string} className="flex items-center gap-4 px-5 py-3 group">
                    <span className="text-muted-foreground text-sm w-6 text-right shrink-0">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{(video.video_title as string) || (video.video_id as string)}</p>
                      {hasTx && typeof video.transcript_word_count === 'number' && <p className="text-xs text-muted-foreground mt-0.5">{(video.transcript_word_count as number).toLocaleString()} words</p>}
                      {tStatus === 'failed' && txError && <p className="text-xs text-destructive mt-0.5 truncate" title={txError}>{txError}</p>}
                      {rStatus === 'failed' && rwError && <p className="text-xs text-destructive mt-0.5 truncate" title={rwError}>{rwError}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'} className="text-xs">
                        {tStatus === 'done' ? '✓ Transcript' : tStatus === 'failed' ? '✗ No transcript' : tStatus === 'skipped' ? '— Skipped' : tStatus === 'processing' ? 'Extracting…' : 'Pending'}
                      </Badge>
                      {rStatus && rStatus !== 'not_started' && (
                        <Badge variant={REWRITE_VARIANTS[rStatus] ?? 'secondary'} className="text-xs">
                          {rStatus === 'done' ? '✓ Rewritten' : rStatus === 'failed' ? '✗ Rewrite failed' : rStatus === 'processing' ? 'Rewriting…' : rStatus === 'queued' ? 'Queued' : rStatus}
                        </Badge>
                      )}
                      {hasTx && (
                        <button onClick={() => setViewingVideo(video)} title="View transcript" className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100">
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
