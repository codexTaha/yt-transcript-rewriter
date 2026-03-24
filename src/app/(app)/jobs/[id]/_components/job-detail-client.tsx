'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  Loader2, X, FileText, Trash2, Download,
  Sparkles, ChevronRight, AlertTriangle,
} from 'lucide-react';

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
  completed_with_errors: 'Done with Errors',
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

const ACTIVE_STATUSES = new Set([
  'created', 'discovering', 'extracting',
  'awaiting_prompt',
  'queued_for_rewrite', 'rewriting', 'building_export',
]);

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

type ModalState = 'none' | 'transcript_complete' | 'prompt' | 'export_ready';

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ─── Transcript Viewer Modal ──────────────────────────────────────────────────
function TranscriptModal({ jobId, video, onClose }: { jobId: string; video: JobVideo; onClose: () => void }) {
  const [text, setText]       = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/transcript?video_id=${video.video_id as string}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { if (d.success) setText(d.data.text as string); else setError((d.error as string) ?? 'Failed'); } })
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
  const language  = typeof video.transcript_language  === 'string' ? (video.transcript_language  as string).toUpperCase() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
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
            <Button size="sm" variant="outline"
              onClick={() => { if (text) { navigator.clipboard.writeText(text); toast.success('Copied!'); } }}
              disabled={!text}>Copy</Button>
            <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <X className="h-4 w-4" />
            </button>
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

// ─── Transcript Complete Modal ────────────────────────────────────────────────
function TranscriptCompleteModal({ transcriptCount, onRewrite, onExportRaw, onDismiss, exportingRaw }: {
  transcriptCount: number; onRewrite: () => void; onExportRaw: () => void;
  onDismiss: () => void; exportingRaw: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="bg-gradient-to-br from-primary/10 to-transparent px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-7 w-7 rounded-full bg-green-500/20 flex items-center justify-center"><span className="text-sm">✅</span></div>
                <h2 className="text-lg font-bold text-foreground">Transcripts Ready!</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">{transcriptCount}</strong> transcript{transcriptCount !== 1 ? 's' : ''} extracted. What would you like to do?
              </p>
            </div>
            <button onClick={onDismiss} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-6 pb-6 pt-2 flex flex-col gap-3">
          <button onClick={onRewrite}
            className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-primary/30 bg-primary/5 hover:border-primary hover:bg-primary/10 transition-all text-left group">
            <div className="p-2.5 rounded-lg bg-primary/15 text-primary shrink-0"><Sparkles className="h-5 w-5" /></div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Rewrite with AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">Enter a prompt — AI rewrites all transcripts into polished content.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
          <button onClick={onExportRaw} disabled={exportingRaw}
            className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:border-primary/40 hover:bg-muted/50 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
            <div className="p-2.5 rounded-lg bg-muted text-muted-foreground shrink-0">
              {exportingRaw ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground">Export raw transcripts</p>
              <p className="text-xs text-muted-foreground mt-0.5">Download all transcripts as a <code className="font-mono">.txt</code> file.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Export Ready Modal ───────────────────────────────────────────────────────
function ExportReadyModal({ rewriteCount, hasErrors, onDownload, onExportRaw, onDismiss, downloading, exportingRaw }: {
  rewriteCount: number; hasErrors: boolean; onDownload: () => void; onExportRaw: () => void;
  onDismiss: () => void; downloading: boolean; exportingRaw: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="bg-gradient-to-br from-green-500/10 to-transparent px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-7 w-7 rounded-full bg-green-500/20 flex items-center justify-center"><span className="text-sm">🎉</span></div>
                <h2 className="text-lg font-bold text-foreground">Rewrites Complete!</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">{rewriteCount}</strong> script{rewriteCount !== 1 ? 's' : ''} rewritten.
                {hasErrors && <span className="text-amber-500 ml-1">Some videos had errors.</span>}
              </p>
            </div>
            <button onClick={onDismiss} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-6 pb-6 pt-2 flex flex-col gap-3">
          <button onClick={onDownload} disabled={downloading}
            className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-primary/30 bg-primary/5 hover:border-primary hover:bg-primary/10 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
            <div className="p-2.5 rounded-lg bg-primary/15 text-primary shrink-0">
              {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Download Markdown Bundle</p>
              <p className="text-xs text-muted-foreground mt-0.5">All rewritten scripts in one <code className="font-mono">.md</code> file.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
          <button onClick={onExportRaw} disabled={exportingRaw}
            className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:border-primary/40 hover:bg-muted/50 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
            <div className="p-2.5 rounded-lg bg-muted text-muted-foreground shrink-0">
              {exportingRaw ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground">Export raw transcripts</p>
              <p className="text-xs text-muted-foreground mt-0.5">Download original transcripts as <code className="font-mono">.txt</code>.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
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
            <h2 className="text-lg font-bold text-foreground">AI Rewrite Prompt</h2>
            <p className="text-sm text-muted-foreground mt-0.5">Applied to all <strong className="text-foreground">{transcriptCount}</strong> transcript{transcriptCount !== 1 ? 's' : ''}.</p>
          </div>
          <button onClick={onBack} disabled={submitting} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 pb-6">
          <Textarea
            autoFocus
            placeholder="e.g. Rewrite this YouTube transcript as a clean, engaging blog post. Remove filler words and timestamps."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={6}
            className="mb-4 resize-none"
            disabled={submitting}
          />
          <div className="flex items-center gap-3 justify-end">
            <Button variant="outline" onClick={onBack} disabled={submitting}>← Back</Button>
            <Button onClick={() => onSubmit(prompt)} disabled={submitting || !prompt.trim()}>
              {submitting
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Submitting…</>
                : <><Sparkles className="h-4 w-4 mr-2" />Rewrite {transcriptCount} transcript{transcriptCount !== 1 ? 's' : ''}</>
              }
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
//
// Architecture decision: we use a SINGLE tight polling loop (every 2s while
// active) as the ONLY source of truth for status transitions. We deliberately
// do NOT rely on React closure-captured callbacks in pump loops or Realtime
// events to trigger modals, because those suffer from stale-closure bugs and
// hot-reload ref-carryover. The poll is a simple setInterval that reads the DB
// and updates state — dead simple, impossible to miss a transition.
//
// The pump functions continue to exist to DRIVE server work (kick off workers),
// but modal triggering is 100% owned by the polling loop.

export function JobDetailClient({ job: initialJob, initialVideos }: { job: Job; initialVideos: JobVideo[] }) {
  const router = useRouter();

  const [job,      setJob]      = useState<Job>(initialJob);
  const [videos,   setVideos]   = useState<JobVideo[]>(initialVideos);
  const [hydrated, setHydrated] = useState(initialVideos.length > 0);
  const [modal,    setModal]    = useState<ModalState>('none');

  // ── Plain refs (never stale — only read as current values) ────────────────
  const statusRef            = useRef<string>(initialJob.status as string);
  const modalRef             = useRef<ModalState>('none');
  const txModalShownRef      = useRef<boolean>(false);
  const exportModalShownRef  = useRef<boolean>(false);
  const pumpRunningRef       = useRef<Record<string, boolean>>({});
  const jobIdRef             = useRef<string>(initialJob.id as string);

  // Keep modalRef in sync with modal state
  const setModalSafe = (m: ModalState) => {
    modalRef.current = m;
    setModal(m);
  };

  const [isProcessing,    setIsProcessing]    = useState(ACTIVE_STATUSES.has(initialJob.status as string));
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [downloading,      setDownloading]      = useState(false);
  const [exportingRaw,     setExportingRaw]     = useState(false);
  const [cancelling,       setCancelling]       = useState(false);
  const [deleting,         setDeleting]         = useState(false);
  const [viewingVideo,     setViewingVideo]     = useState<JobVideo | null>(null);

  const jobId = initialJob.id as string;

  // ── triggerModal — the ONLY function that opens stage-transition modals ──
  // Called exclusively from the polling loop. Checks ref guards so it fires
  // exactly once per stage, even if called multiple times.
  function triggerModalForStatus(s: string) {
    if (s === 'awaiting_prompt' && !txModalShownRef.current) {
      txModalShownRef.current = true;
      setModalSafe('transcript_complete');
    }
    if ((s === 'completed' || s === 'completed_with_errors') && !exportModalShownRef.current) {
      exportModalShownRef.current = true;
      setModalSafe('export_ready');
    }
  }

  // ── kickPump — fire-and-forget pump driver ────────────────────────────────
  // Only DRIVES server workers. Does NOT trigger modals. Polling handles that.
  async function kickPump(endpoint: string) {
    if (pumpRunningRef.current[endpoint]) return;
    pumpRunningRef.current[endpoint] = true;
    const jobIdNow = jobIdRef.current;
    try {
      while (true) {
        const s = statusRef.current;
        if (TERMINAL_STATUSES.has(s)) break;
        if (endpoint.includes('extract') && s !== 'extracting')                               break;
        if (endpoint.includes('rewrite') && !['rewriting','queued_for_rewrite'].includes(s)) break;

        let data: { success: boolean; data?: { remaining?: number; advanced?: boolean; waiting?: boolean } } | null = null;
        try {
          const res = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ job_id: jobIdNow }),
          });
          if (res.ok) data = await res.json();
        } catch { /* network hiccup — keep looping, polling will catch status */ }

        if (data?.data?.advanced)                       break; // polling will see new status
        if ((data?.data?.remaining ?? 1) === 0)         break; // done, polling will see it
        if (data?.data?.waiting)                        { await sleep(3000); continue; }
        if (!data)                                      { await sleep(5000); continue; }

        await sleep(1500);
      }
    } finally {
      pumpRunningRef.current[endpoint] = false;
    }
  }

  // ── MAIN POLLING LOOP ─────────────────────────────────────────────────────
  // This is the definitive fix. A simple setInterval that:
  //  1. Reads the authoritative job status from DB every 2s
  //  2. Updates React state
  //  3. Triggers modals on transition
  //  4. Kicks pumps when status demands it
  //  5. Stops when terminal AND all expected modals shown
  useEffect(() => {
    const supabase = createClient();
    let destroyed  = false;

    // Seed initial state
    statusRef.current = initialJob.status as string;
    triggerModalForStatus(initialJob.status as string);

    const tick = async () => {
      if (destroyed) return;
      try {
        // ── Fetch job
        const { data: jobData } = await supabase
          .from('jobs')
          .select('*')
          .eq('id', jobId)
          .single();

        if (!jobData || destroyed) return;

        const newStatus = jobData.status as string;
        const oldStatus = statusRef.current;

        // Update state unconditionally so counts/fields stay fresh
        statusRef.current = newStatus;
        setJob(jobData as Job);
        setIsProcessing(ACTIVE_STATUSES.has(newStatus));

        // Trigger modal on status change
        if (newStatus !== oldStatus) {
          triggerModalForStatus(newStatus);
          // Kick pump if new status needs one
          if (newStatus === 'extracting')                                    kickPump('/api/worker/pump/extract');
          if (newStatus === 'rewriting' || newStatus === 'queued_for_rewrite') kickPump('/api/worker/pump/rewrite');
        }

        // Also trigger modal on FIRST tick if we arrive on an actionable status
        // (handles page load after job already finished)
        triggerModalForStatus(newStatus);

        // ── Fetch videos (keep list fresh)
        const { data: videosData } = await supabase
          .from('job_videos')
          .select('*')
          .eq('job_id', jobId)
          .order('discovery_position', { ascending: true });

        if (!destroyed && videosData) {
          setVideos(videosData as JobVideo[]);
          setHydrated(true);
        }
      } catch { /* ignore transient errors */ }
    };

    // First tick immediately, then every 2s
    tick();
    const interval = setInterval(tick, 2000);

    // Boot pump for current status on mount
    const s0 = initialJob.status as string;
    if (s0 === 'extracting')                                    kickPump('/api/worker/pump/extract');
    if (s0 === 'rewriting' || s0 === 'queued_for_rewrite')      kickPump('/api/worker/pump/rewrite');

    return () => {
      destroyed = true;
      clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Also subscribe Realtime for live video row updates (cosmetic only) ────
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`job-videos-${jobId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` }, payload => {
        setVideos(prev => {
          if (prev.some(v => (v.id as string) === (payload.new.id as string))) return prev;
          return [...prev, payload.new as JobVideo];
        });
        setHydrated(true);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` }, payload => {
        setVideos(prev => prev.map(v => (v.id as string) === (payload.new.id as string) ? payload.new as JobVideo : v));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleSubmitPrompt = async (promptText: string) => {
    setSubmittingPrompt(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_prompt: promptText }),
      });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success(`Queued ${data.data.queued_count as number} video${(data.data.queued_count as number) !== 1 ? 's' : ''} for rewriting`);
      setModalSafe('none');
      statusRef.current = 'queued_for_rewrite';
      setIsProcessing(true);
      setJob(prev => ({ ...prev, status: 'queued_for_rewrite' }));
      kickPump('/api/worker/pump/rewrite');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit prompt');
    } finally {
      setSubmittingPrompt(false);
    }
  };

  const handleExportRaw = async () => {
    if (exportingRaw) return;
    setExportingRaw(true);
    setModalSafe('none');
    try {
      const res = await fetch(`/api/jobs/${jobId}/export-transcripts`);
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `transcripts-${jobId.slice(0, 8)}.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Transcripts downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingRaw(false);
    }
  };

  const handleDownloadRewritten = async () => {
    setDownloading(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/download`);
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
      const res  = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job cancelled');
      statusRef.current = 'cancelled';
      setIsProcessing(false);
      setJob(prev => ({ ...prev, status: 'cancelled' }));
      setModalSafe('none');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Permanently delete this job and ALL its data?')) return;
    setDeleting(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/delete`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success('Job deleted');
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
      setDeleting(false);
    }
  };

  // ── Derived values ────────────────────────────────────────────────────────
  const status         = job.status as string;
  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const rewriteDone    = videos.filter(v => v.rewrite_status    === 'done').length;
  const totalVideos    = hydrated ? videos.length : ((job.total_video_count as number) || 0);
  const isCancellable  = CANCELLABLE_STATUSES.includes(status);
  const isActive       = ACTIVE_STATUSES.has(status);

  const showFAB =
    (status === 'awaiting_prompt'    && modal === 'none') ||
    ((status === 'completed' || status === 'completed_with_errors') && modal === 'none');

  const handleFABClick = () => {
    if (status === 'awaiting_prompt') {
      txModalShownRef.current = false;
      triggerModalForStatus('awaiting_prompt');
    } else if (status === 'completed' || status === 'completed_with_errors') {
      exportModalShownRef.current = false;
      triggerModalForStatus(status);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {viewingVideo && <TranscriptModal jobId={jobId} video={viewingVideo} onClose={() => setViewingVideo(null)} />}

      {modal === 'transcript_complete' && (
        <TranscriptCompleteModal
          transcriptCount={transcriptDone}
          onRewrite={() => setModalSafe('prompt')}
          onExportRaw={handleExportRaw}
          onDismiss={() => setModalSafe('none')}
          exportingRaw={exportingRaw}
        />
      )}

      {modal === 'prompt' && (
        <RewritePromptModal
          transcriptCount={transcriptDone}
          onSubmit={handleSubmitPrompt}
          onBack={() => setModalSafe('transcript_complete')}
          submitting={submittingPrompt}
        />
      )}

      {modal === 'export_ready' && (
        <ExportReadyModal
          rewriteCount={rewriteDone}
          hasErrors={status === 'completed_with_errors'}
          onDownload={handleDownloadRewritten}
          onExportRaw={handleExportRaw}
          onDismiss={() => setModalSafe('none')}
          downloading={downloading}
          exportingRaw={exportingRaw}
        />
      )}

      {/* FAB — Progress button, bottom-right */}
      {showFAB && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={handleFABClick}
            title="Open next step"
            className="flex items-center gap-2.5 h-12 px-5 rounded-full shadow-xl border border-primary/40 bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 active:scale-95 transition-all"
          >
            <span>Progress</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="min-h-screen bg-background pb-20">
        <div className="max-w-5xl mx-auto px-4 py-8">

          {/* Header */}
          <div className="flex items-start justify-between mb-8 gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                <span>📋</span>
                <span className="capitalize font-medium">{job.source_type as string}</span>
              </div>
              <h1 className="text-2xl font-bold text-foreground truncate">{(job.source_name as string) || 'Loading…'}</h1>
              <p className="text-muted-foreground text-sm mt-1 truncate">{job.source_url as string}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'} className="h-7 px-3">
                {isActive && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
                {STATUS_LABELS[status] ?? status}
              </Badge>
              {isCancellable && (
                <button onClick={handleCancel} disabled={cancelling || deleting}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold border-2 border-amber-500/60 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 hover:border-amber-500 transition-all disabled:opacity-40">
                  {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertTriangle className="h-3 w-3" />}
                  {cancelling ? 'Cancelling…' : 'Cancel Job'}
                </button>
              )}
              <button onClick={handleDelete} disabled={deleting || cancelling}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold border-2 border-red-500/60 text-red-500 bg-red-500/10 hover:bg-red-500/20 hover:border-red-500 transition-all disabled:opacity-40">
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold">{hydrated ? videos.length : <Loader2 className="h-5 w-5 animate-spin inline text-muted-foreground" />}</div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Videos</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold">{transcriptDone}<span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span></div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Transcripts</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold">{rewriteDone}<span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span></div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Rewritten</div>
            </div>
          </div>

          {/* Status banners */}
          {status === 'cancelled' && (
            <div className="bg-muted/40 border border-border rounded-xl p-5 mb-6">
              <p className="font-semibold">Job cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                {transcriptDone > 0 ? `${transcriptDone} transcript(s) extracted before cancellation.` : 'No transcripts were extracted.'}
              </p>
              {transcriptDone > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Export transcripts</>}
                </Button>
              )}
            </div>
          )}

          {(status === 'completed' || status === 'completed_with_errors') && (
            <div className="bg-gradient-to-r from-green-500/10 to-transparent border border-green-500/30 rounded-xl p-5 mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold">🎉 Rewrites ready to export</p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {rewriteDone} script{rewriteDone !== 1 ? 's' : ''} done.
                  {status === 'completed_with_errors' && <span className="text-amber-500 ml-1">Some videos had errors.</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" onClick={handleDownloadRewritten} disabled={downloading}>
                  {downloading ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Generating…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Download</>}
                </Button>
                <Button size="sm" variant="outline" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? 'Preparing…' : 'Raw .txt'}
                </Button>
              </div>
            </div>
          )}

          {status === 'failed' && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 mb-6">
              <p className="text-red-400 font-semibold flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Job failed</p>
              <p className="text-sm text-muted-foreground mt-1">{(job.error_message as string) || 'An unknown error occurred.'}</p>
              {transcriptDone > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? 'Preparing…' : <><Download className="h-3.5 w-3.5 mr-1.5" />Export transcripts anyway</>}
                </Button>
              )}
            </div>
          )}

          {/* Video list */}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold">Videos ({hydrated ? videos.length : ((job.total_video_count as number) || '…')})</h2>
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
                  <div key={video.id as string} className="flex items-center gap-3 px-5 py-3 group hover:bg-muted/30 transition-colors">
                    <span className="text-muted-foreground text-xs w-6 text-right shrink-0 font-mono">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{(video.video_title as string) || (video.video_id as string)}</p>
                      {hasTx && typeof video.transcript_word_count === 'number' && (
                        <p className="text-xs text-muted-foreground mt-0.5">{(video.transcript_word_count as number).toLocaleString()} words</p>
                      )}
                      {tStatus === 'failed' && txError && <p className="text-xs text-red-400 mt-0.5 truncate" title={txError}>{txError}</p>}
                      {rStatus === 'failed' && rwError && <p className="text-xs text-red-400 mt-0.5 truncate" title={rwError}>{rwError}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'} className="text-xs">
                        {tStatus === 'done' ? '✓ Transcript' : tStatus === 'failed' ? '✗ Failed' : tStatus === 'skipped' ? '— Skipped' : tStatus === 'processing' ? 'Extracting…' : 'Pending'}
                      </Badge>
                      {rStatus && rStatus !== 'not_started' && (
                        <Badge variant={REWRITE_VARIANTS[rStatus] ?? 'secondary'} className="text-xs">
                          {rStatus === 'done' ? '✓ Rewritten' : rStatus === 'failed' ? '✗ Failed' : rStatus === 'processing' ? 'Rewriting…' : rStatus === 'queued' ? 'Queued' : rStatus}
                        </Badge>
                      )}
                      {hasTx && (
                        <button onClick={() => setViewingVideo(video)} title="View transcript"
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100">
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
