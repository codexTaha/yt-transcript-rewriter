'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  Loader2, X, FileText, Trash2, Download, Pencil,
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

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

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

// ─── Transcript Completion Modal (after extraction) ───────────────────────────

function TranscriptCompleteModal({ transcriptCount, onRewrite, onExportRaw, onDismiss, exportingRaw }: {
  transcriptCount: number; onRewrite: () => void; onExportRaw: () => void; onDismiss: () => void; exportingRaw: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-primary/10 to-transparent px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-7 w-7 rounded-full bg-green-500/20 flex items-center justify-center">
                  <span className="text-sm">✅</span>
                </div>
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
        {/* Options */}
        <div className="px-6 pb-6 pt-2 flex flex-col gap-3">
          <button onClick={onRewrite} className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-primary/30 bg-primary/5 hover:border-primary hover:bg-primary/10 transition-all text-left group">
            <div className="p-2.5 rounded-lg bg-primary/15 text-primary shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Rewrite with AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">Enter a prompt — AI rewrites all transcripts into polished content.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
          <button onClick={onExportRaw} disabled={exportingRaw} className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:border-primary/40 hover:bg-muted/50 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
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

// ─── Export Ready Modal (after rewrites complete) ─────────────────────────────

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="bg-gradient-to-br from-green-500/10 to-transparent px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-7 w-7 rounded-full bg-green-500/20 flex items-center justify-center">
                  <span className="text-sm">🎉</span>
                </div>
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
          <button onClick={onDownload} disabled={downloading} className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-primary/30 bg-primary/5 hover:border-primary hover:bg-primary/10 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
            <div className="p-2.5 rounded-lg bg-primary/15 text-primary shrink-0">
              {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Download Markdown Bundle</p>
              <p className="text-xs text-muted-foreground mt-0.5">All rewritten scripts in one <code className="font-mono">.md</code> file.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
          <button onClick={onExportRaw} disabled={exportingRaw} className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:border-primary/40 hover:bg-muted/50 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed">
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
            placeholder="e.g. Rewrite this YouTube transcript as a clean, engaging blog post. Remove filler words and timestamps. Use markdown headings where appropriate."
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

type ModalState = 'none' | 'transcript_complete' | 'prompt' | 'export_ready';

export function JobDetailClient({ job: initialJob, initialVideos }: { job: Job; initialVideos: JobVideo[] }) {
  const router = useRouter();

  const [job,      setJob]      = useState<Job>(initialJob);
  const [videos,   setVideos]   = useState<JobVideo[]>(initialVideos);
  const [hydrated, setHydrated] = useState(initialVideos.length > 0);
  const [modal,    setModal]    = useState<ModalState>('none');

  // Refs — never drive render, used inside callbacks/intervals/pumps
  const jobRef              = useRef<Job>(initialJob);
  const videosRef           = useRef<JobVideo[]>(initialVideos);
  const statusRef           = useRef<string>(initialJob.status as string);
  const pumpRunning         = useRef<Record<string, boolean>>({});
  const transcriptModalShown = useRef<boolean>(false);
  const exportModalShown    = useRef<boolean>(false);
  // Track if something is still in-flight so the FAB can be grayed out
  const [isProcessing, setIsProcessing] = useState(
    ACTIVE_STATUSES.has(initialJob.status as string)
  );

  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const [downloading,      setDownloading]      = useState(false);
  const [exportingRaw,     setExportingRaw]     = useState(false);
  const [cancelling,       setCancelling]       = useState(false);
  const [deleting,         setDeleting]         = useState(false);
  const [viewingVideo,     setViewingVideo]     = useState<JobVideo | null>(null);

  const jobId = initialJob.id as string;

  // ── applyJobUpdate — single place that mutates job state ─────────────────
  const applyJobUpdate = useCallback((incoming: Job): boolean => {
    const oldStatus = jobRef.current.status as string;
    const newStatus = incoming.status       as string;
    jobRef.current  = incoming;
    setJob(incoming);
    if (newStatus !== oldStatus) {
      statusRef.current = newStatus;
      setIsProcessing(ACTIVE_STATUSES.has(newStatus));
      return true;
    }
    return false;
  }, []);

  // ── applyVideoUpdate ──────────────────────────────────────────────────────
  const applyVideoUpdate = useCallback((incoming: JobVideo) => {
    setVideos(prev => {
      const next = prev.some(v => (v.id as string) === (incoming.id as string))
        ? prev.map(v => (v.id as string) === (incoming.id as string) ? incoming : v)
        : [...prev, incoming];
      videosRef.current = next;
      return next;
    });
    setHydrated(true);
  }, []);

  // ── maybeShowModal — central modal trigger, called from EVERY status path ─
  // This is the definitive fix for the pipeline transition bug:
  // Both stage transitions (extracting→awaiting_prompt AND completed) trigger here.
  const maybeShowModal = useCallback((s: string) => {
    if (s === 'awaiting_prompt' && !transcriptModalShown.current) {
      transcriptModalShown.current = true;
      // Small delay so UI settles before popup appears
      setTimeout(() => setModal('transcript_complete'), 800);
    }
    if ((s === 'completed' || s === 'completed_with_errors') && !exportModalShown.current) {
      exportModalShown.current = true;
      setTimeout(() => setModal('export_ready'), 800);
    }
  }, []);

  // ── syncStatusFromDB — authoritative DB read ──────────────────────────────
  const syncStatusFromDB = useCallback(async (): Promise<string> => {
    try {
      const supabase = createClient();
      const { data } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (data) {
        const changed = applyJobUpdate(data as Job);
        if (changed) maybeShowModal(data.status as string);
        return data.status as string;
      }
    } catch { /* ignore transient */ }
    return statusRef.current;
  }, [jobId, applyJobUpdate, maybeShowModal]);

  // ── pump — drives server-side workers ────────────────────────────────────
  // FIX: when pump sees `waiting` (workers still processing) it now schedules
  // a DB sync after a delay EVEN IF it breaks out, so the transition is never
  // missed if Realtime is flaky or the pump exits the loop early.
  const pump = useCallback(async (endpoint: string) => {
    if (pumpRunning.current[endpoint]) return;
    pumpRunning.current[endpoint] = true;
    try {
      while (true) {
        const s = statusRef.current;
        if (TERMINAL_STATUSES.has(s)) break;
        if (endpoint.includes('extract') && s !== 'extracting') break;
        if (endpoint.includes('rewrite') && !['rewriting', 'queued_for_rewrite'].includes(s)) break;

        let resp: { success: boolean; data?: { remaining?: number; advanced?: boolean; next_status?: string; waiting?: boolean } } | null = null;
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobId }),
          });
          if (!res.ok) { await sleep(5000); continue; }
          resp = await res.json();
        } catch {
          await syncStatusFromDB();
          await sleep(3000);
          continue;
        }

        // 1. Server says job advanced to next status
        if (resp?.data?.advanced) {
          const next = resp.data.next_status;
          if (next) {
            statusRef.current = next;
            setIsProcessing(ACTIVE_STATUSES.has(next));
            setJob(prev => { const u = { ...prev, status: next }; jobRef.current = u; return u; });
            maybeShowModal(next);
          } else {
            await syncStatusFromDB();
          }
          break;
        }

        // 2. Workers still processing — wait, then ALWAYS sync DB so we catch
        //    the transition even if the pump exits before seeing advanced:true
        if (resp?.data?.waiting) {
          await sleep(3000);
          // After waiting, sync DB directly — don't rely on the next pump call
          await syncStatusFromDB();
          // If we've now left the valid status range, break
          const sNow = statusRef.current;
          if (TERMINAL_STATUSES.has(sNow)) break;
          if (endpoint.includes('extract') && sNow !== 'extracting') break;
          if (endpoint.includes('rewrite') && !['rewriting', 'queued_for_rewrite'].includes(sNow)) break;
          continue;
        }

        // 3. Nothing remaining — sync DB before breaking (guards against race)
        if ((resp?.data?.remaining ?? 1) <= 0) {
          await syncStatusFromDB();
          break;
        }

        await sleep(2000);
      }
    } finally {
      pumpRunning.current[endpoint] = false;
      // CRITICAL: after any pump exits, do one final DB sync.
      // This is the safety net that guarantees the modal fires even if every
      // other path above failed to detect the status transition.
      await syncStatusFromDB();
    }
  }, [jobId, maybeShowModal, syncStatusFromDB]);

  // ── startPumpIfNeeded ─────────────────────────────────────────────────────
  const startPumpIfNeeded = useCallback((s: string) => {
    if (s === 'extracting')                                   pump('/api/worker/pump/extract');
    else if (s === 'rewriting' || s === 'queued_for_rewrite') pump('/api/worker/pump/rewrite');
  }, [pump]);

  // ── Mount: fresh DB fetch + boot pumps ───────────────────────────────────
  useEffect(() => {
    let active = true;
    const supabase = createClient();
    supabase.from('jobs').select('*').eq('id', jobId).single().then(({ data }) => {
      if (!active || !data) return;
      applyJobUpdate(data as Job);
      maybeShowModal(data.status as string);
      startPumpIfNeeded(data.status as string);
    });
    supabase.from('job_videos').select('*').eq('job_id', jobId).order('discovery_position', { ascending: true }).then(({ data }) => {
      if (!active || !data) return;
      videosRef.current = data as JobVideo[];
      setVideos(data as JobVideo[]);
      setHydrated(true);
    });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Realtime ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`job-detail-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` }, payload => {
        const updated = payload.new as Job;
        const changed = applyJobUpdate(updated);
        if (changed) { maybeShowModal(updated.status as string); startPumpIfNeeded(updated.status as string); }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` }, payload => applyVideoUpdate(payload.new as JobVideo))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` }, payload => applyVideoUpdate(payload.new as JobVideo))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'job_videos', filter: `job_id=eq.${jobId}` }, payload => {
        setVideos(prev => { const next = prev.filter(v => (v.id as string) !== (payload.old.id as string)); videosRef.current = next; return next; });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Polling fallback — runs while job is active ───────────────────────────
  // Polls every 4s regardless of pump/Realtime state. This is the ultimate
  // safety net: if pump exits without triggering modal and Realtime is down,
  // polling will pick up the status change and call maybeShowModal.
  useEffect(() => {
    let active = true;
    const supabase = createClient();

    const poll = async () => {
      if (!active) return;
      const s = statusRef.current;
      // Keep polling through ACTIVE and also newly-terminal states until we
      // know the modal has been shown
      if (TERMINAL_STATUSES.has(s) && exportModalShown.current && transcriptModalShown.current) return;

      try {
        const { data } = await supabase.from('jobs').select('*').eq('id', jobId).single();
        if (!active || !data) return;
        const changed = applyJobUpdate(data as Job);
        if (changed) {
          maybeShowModal(data.status as string);
          startPumpIfNeeded(data.status as string);
        }
      } catch { /* ignore */ }

      if (!active) return;
      // Stop only when truly terminal AND all relevant modals already shown
      const sNow = statusRef.current;
      const done = TERMINAL_STATUSES.has(sNow) && exportModalShown.current && transcriptModalShown.current;
      if (!done) setTimeout(poll, 4000);
    };

    const tid = setTimeout(poll, 4000);
    return () => { active = false; clearTimeout(tid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // ── Boot pumps on initial load ────────────────────────────────────────────
  useEffect(() => {
    startPumpIfNeeded(initialJob.status as string);
    maybeShowModal(initialJob.status as string);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleSubmitPrompt = async (promptText: string) => {
    setSubmittingPrompt(true);
    try {
      const res  = await fetch(`/api/jobs/${jobId}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ master_prompt: promptText }) });
      const data = await res.json();
      if (!data.success) throw new Error((data.error as string) ?? 'Unknown error');
      toast.success(`Queued ${data.data.queued_count as number} video${(data.data.queued_count as number) !== 1 ? 's' : ''} for rewriting`);
      setModal('none');
      statusRef.current = 'queued_for_rewrite';
      setIsProcessing(true);
      setJob(prev => { const u = { ...prev, status: 'queued_for_rewrite' }; jobRef.current = u; return u; });
      pump('/api/worker/pump/rewrite');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit prompt');
    } finally {
      setSubmittingPrompt(false);
    }
  };

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
      setJob(prev => { const u = { ...prev, status: 'cancelled' }; jobRef.current = u; return u; });
      setModal('none');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to cancel'); }
    finally { setCancelling(false); }
  };

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

  // ── Derived values ────────────────────────────────────────────────────────
  const status         = job.status as string;
  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const rewriteDone    = videos.filter(v => v.rewrite_status    === 'done').length;
  const totalVideos    = hydrated ? videos.length : ((job.total_video_count as number) || 0);
  const isCancellable  = CANCELLABLE_STATUSES.includes(status);
  const isActive       = ACTIVE_STATUSES.has(status);

  // ── FAB visibility — "Progress" button bottom-right ──────────────────────
  // Shown when: transcript phase done (awaiting_prompt) OR rewrite phase done (completed*)
  // Disabled when something is processing
  const showFAB =
    (status === 'awaiting_prompt' && modal === 'none') ||
    ((status === 'completed' || status === 'completed_with_errors') && modal === 'none');

  const handleFABClick = () => {
    if (isProcessing) return;
    if (status === 'awaiting_prompt') {
      transcriptModalShown.current = false;
      maybeShowModal('awaiting_prompt');
    } else if (status === 'completed' || status === 'completed_with_errors') {
      exportModalShown.current = false;
      maybeShowModal(status);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Modals */}
      {viewingVideo && <TranscriptModal jobId={jobId} video={viewingVideo} onClose={() => setViewingVideo(null)} />}

      {modal === 'transcript_complete' && (
        <TranscriptCompleteModal
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
          onSubmit={handleSubmitPrompt}
          onBack={() => setModal('transcript_complete')}
          submitting={submittingPrompt}
        />
      )}

      {modal === 'export_ready' && (
        <ExportReadyModal
          rewriteCount={rewriteDone}
          hasErrors={status === 'completed_with_errors'}
          onDownload={handleDownloadRewritten}
          onExportRaw={handleExportRaw}
          onDismiss={() => setModal('none')}
          downloading={downloading}
          exportingRaw={exportingRaw}
        />
      )}

      {/* FAB — Progress button, bottom-right */}
      {showFAB && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={handleFABClick}
            disabled={isProcessing}
            title={isProcessing ? 'Processing…' : 'Open next step'}
            className="flex items-center gap-2.5 h-12 px-5 rounded-full shadow-xl border border-primary/40 bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>Progress</span>
            {!isProcessing && <ChevronRight className="h-4 w-4" />}
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

            {/* Status + actions */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'} className="h-7 px-3">
                {isActive && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
                {STATUS_LABELS[status] ?? status}
              </Badge>

              {isCancellable && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling || deleting}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold border-2 border-amber-500/60 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 hover:border-amber-500 transition-all disabled:opacity-40"
                >
                  {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertTriangle className="h-3 w-3" />}
                  {cancelling ? 'Cancelling…' : 'Cancel Job'}
                </button>
              )}

              <button
                onClick={handleDelete}
                disabled={deleting || cancelling}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold border-2 border-red-500/60 text-red-500 bg-red-500/10 hover:bg-red-500/20 hover:border-red-500 transition-all disabled:opacity-40"
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold text-foreground">{hydrated ? videos.length : <Loader2 className="h-5 w-5 animate-spin inline text-muted-foreground" />}</div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Videos</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold text-foreground">
                {transcriptDone}
                <span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span>
              </div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Transcripts</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold text-foreground">
                {rewriteDone}
                <span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span>
              </div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Rewritten</div>
            </div>
          </div>

          {/* Cancelled banner */}
          {status === 'cancelled' && (
            <div className="bg-muted/40 border border-border rounded-xl p-5 mb-6">
              <p className="font-semibold text-foreground">Job cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                {transcriptDone > 0
                  ? `${transcriptDone} transcript(s) extracted before cancellation.`
                  : 'No transcripts were extracted.'}
              </p>
              {transcriptDone > 0 && (
                <Button size="sm" variant="outline" className="mt-3" onClick={handleExportRaw} disabled={exportingRaw}>
                  {exportingRaw ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Export transcripts</>}
                </Button>
              )}
            </div>
          )}

          {/* Completed banner (static, popup handles primary CTA) */}
          {(status === 'completed' || status === 'completed_with_errors') && (
            <div className="bg-gradient-to-r from-green-500/10 to-transparent border border-green-500/30 rounded-xl p-5 mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-foreground">🎉 Rewrites ready to export</p>
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

          {/* Failed banner */}
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
              <h2 className="font-semibold text-foreground">Videos ({hydrated ? videos.length : ((job.total_video_count as number) || '…')})</h2>
              {!hydrated && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            {!hydrated && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {hydrated && videos.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">No videos found yet.</div>
            )}
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
                      <p className="text-sm text-foreground truncate font-medium">{(video.video_title as string) || (video.video_id as string)}</p>
                      {hasTx && typeof video.transcript_word_count === 'number' && (
                        <p className="text-xs text-muted-foreground mt-0.5">{(video.transcript_word_count as number).toLocaleString()} words</p>
                      )}
                      {tStatus === 'failed' && txError && (
                        <p className="text-xs text-red-400 mt-0.5 truncate" title={txError}>{txError}</p>
                      )}
                      {rStatus === 'failed' && rwError && (
                        <p className="text-xs text-red-400 mt-0.5 truncate" title={rwError}>{rwError}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'} className="text-xs">
                        {tStatus === 'done' ? '✓ Transcript'
                          : tStatus === 'failed' ? '✗ Failed'
                          : tStatus === 'skipped' ? '— Skipped'
                          : tStatus === 'processing' ? 'Extracting…'
                          : 'Pending'}
                      </Badge>
                      {rStatus && rStatus !== 'not_started' && (
                        <Badge variant={REWRITE_VARIANTS[rStatus] ?? 'secondary'} className="text-xs">
                          {rStatus === 'done' ? '✓ Rewritten'
                            : rStatus === 'failed' ? '✗ Failed'
                            : rStatus === 'processing' ? 'Rewriting…'
                            : rStatus === 'queued' ? 'Queued'
                            : rStatus}
                        </Badge>
                      )}
                      {hasTx && (
                        <button
                          onClick={() => setViewingVideo(video)}
                          title="View transcript"
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
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
