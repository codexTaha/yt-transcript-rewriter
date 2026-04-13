'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Loader2, X, FileText, Trash2, Download,
  ChevronRight, AlertTriangle, FileDown,
} from 'lucide-react';

type Job = Record<string, unknown>;
type JobVideo = Record<string, unknown>;

const STATUS_LABELS: Record<string, string> = {
  created:               'Created',
  discovering:           'Discovering',
  extracting:            'Extracting',
  awaiting_prompt:       'Transcripts Ready',
  completed:             'Completed',
  completed_with_errors: 'Done with Errors',
  failed:                'Failed',
  cancelled:             'Cancelled',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  created:               'secondary',
  discovering:           'default',
  extracting:            'default',
  awaiting_prompt:       'success',
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

const CANCELLABLE_STATUSES = ['created', 'discovering', 'extracting'];
const ACTIVE_STATUSES      = new Set(['created', 'discovering', 'extracting']);
const TERMINAL_STATUSES    = new Set(['awaiting_prompt', 'completed', 'completed_with_errors', 'failed', 'cancelled']);

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
  const language  = typeof video.transcript_language  === 'string' ? (video.transcript_language as string).toUpperCase() : null;

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

// ─── Export Format Modal (unavoidable) ───────────────────────────────────────
// Cannot be dismissed by backdrop click or Escape — only by choosing a format
// or explicitly pressing Cancel.
function ExportFormatModal({ transcriptCount, jobId, onDismiss }: {
  transcriptCount: number;
  jobId: string;
  onDismiss: () => void;
}) {
  const [exporting, setExporting] = useState<'txt' | 'md' | null>(null);

  async function handleExport(format: 'txt' | 'md') {
    if (exporting) return;
    setExporting(format);
    try {
      const res = await fetch(`/api/jobs/${jobId}/export-transcripts?format=${format}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `transcripts-${jobId.slice(0, 8)}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Transcripts downloaded as .${format}`);
      onDismiss();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }

  return (
    // No onClick on backdrop — intentionally unavoidable
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">

        {/* Header */}
        <div className="bg-gradient-to-br from-green-500/10 to-transparent px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="h-8 w-8 rounded-full bg-green-500/20 flex items-center justify-center">
              <span className="text-base">✅</span>
            </div>
            <h2 className="text-lg font-bold text-foreground">Transcripts Ready!</h2>
          </div>
          <p className="text-sm text-muted-foreground pl-11">
            <strong className="text-foreground">{transcriptCount}</strong> transcript{transcriptCount !== 1 ? 's' : ''} extracted. Choose a format to download.
          </p>
        </div>

        {/* Format options */}
        <div className="px-6 pt-4 pb-2 flex flex-col gap-3">

          {/* .txt */}
          <button
            onClick={() => handleExport('txt')}
            disabled={!!exporting}
            className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-border bg-background hover:border-primary/60 hover:bg-primary/5 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="p-2.5 rounded-lg bg-muted text-muted-foreground group-hover:bg-primary/15 group-hover:text-primary transition-colors shrink-0">
              {exporting === 'txt' ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Plain Text <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded ml-1">.txt</code></p>
              <p className="text-xs text-muted-foreground mt-0.5">Simple text file — easy to read anywhere, paste into any editor.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>

          {/* .md */}
          <button
            onClick={() => handleExport('md')}
            disabled={!!exporting}
            className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-border bg-background hover:border-primary/60 hover:bg-primary/5 transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <div className="p-2.5 rounded-lg bg-muted text-muted-foreground group-hover:bg-primary/15 group-hover:text-primary transition-colors shrink-0">
              {exporting === 'md' ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileDown className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">Markdown <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded ml-1">.md</code></p>
              <p className="text-xs text-muted-foreground mt-0.5">Structured with headings, links, word counts. Great for Obsidian, Notion, or GitHub.</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
        </div>

        {/* Cancel — only dismissal path */}
        <div className="px-6 pb-6 pt-2">
          <button
            onClick={onDismiss}
            disabled={!!exporting}
            className="w-full py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
          >
            Cancel — I&apos;ll download later
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function JobDetailClient({ job: initialJob, initialVideos }: { job: Job; initialVideos: JobVideo[] }) {
  const router = useRouter();

  const [job,      setJob]      = useState<Job>(initialJob);
  const [videos,   setVideos]   = useState<JobVideo[]>(initialVideos);
  const [hydrated, setHydrated] = useState(initialVideos.length > 0);
  const [showExportModal, setShowExportModal] = useState(false);

  const statusRef           = useRef<string>('');
  const exportModalShownRef = useRef<boolean>(false);
  const pumpRunningRef      = useRef<Record<string, boolean>>({});
  const jobIdRef            = useRef<string>(initialJob.id as string);

  const [isProcessing, setIsProcessing] = useState(ACTIVE_STATUSES.has(initialJob.status as string));
  const [exportingTxt, setExportingTxt] = useState(false);
  const [cancelling,   setCancelling]   = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [viewingVideo, setViewingVideo] = useState<JobVideo | null>(null);

  const jobId = initialJob.id as string;

  async function kickPump(endpoint: string) {
    if (pumpRunningRef.current[endpoint]) return;
    pumpRunningRef.current[endpoint] = true;
    const jobIdNow = jobIdRef.current;
    try {
      while (true) {
        const s = statusRef.current;
        if (TERMINAL_STATUSES.has(s)) break;
        if (endpoint.includes('extract') && s !== 'extracting') break;

        let data: { success: boolean; data?: { remaining?: number; advanced?: boolean; waiting?: boolean } } | null = null;
        try {
          const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: jobIdNow }),
          });
          if (res.ok) data = await res.json();
        } catch { /* network hiccup */ }

        if (data?.data?.advanced)               break;
        if ((data?.data?.remaining ?? 1) === 0) break;
        if (data?.data?.waiting)                { await sleep(3000); continue; }
        if (!data)                              { await sleep(5000); continue; }
        await sleep(1500);
      }
    } finally {
      pumpRunningRef.current[endpoint] = false;
    }
  }

  useEffect(() => {
    exportModalShownRef.current = false;
    statusRef.current = '';

    const supabase = createClient();
    let destroyed  = false;

    const tick = async () => {
      if (destroyed) return;
      try {
        const { data: jobData } = await supabase.from('jobs').select('*').eq('id', jobId).single();
        if (!jobData || destroyed) return;
        const newStatus = jobData.status as string;
        const oldStatus = statusRef.current;
        statusRef.current = newStatus;
        setJob(jobData as Job);
        setIsProcessing(ACTIVE_STATUSES.has(newStatus));

        // Show export modal when transcripts are all done
        if (newStatus === 'awaiting_prompt' && !exportModalShownRef.current) {
          exportModalShownRef.current = true;
          setShowExportModal(true);
        }

        if (newStatus !== oldStatus || oldStatus === '') {
          if (newStatus === 'extracting') kickPump('/api/worker/pump/extract');
        }

        const { data: videosData } = await supabase
          .from('job_videos').select('*').eq('job_id', jobId).order('discovery_position', { ascending: true });
        if (!destroyed && videosData) { setVideos(videosData as JobVideo[]); setHydrated(true); }
      } catch { /* ignore transient errors */ }
    };

    const s0 = initialJob.status as string;
    statusRef.current = s0;
    if (s0 === 'extracting') kickPump('/api/worker/pump/extract');
    // If page loads on a completed job, show modal if not yet dismissed
    if (s0 === 'awaiting_prompt' && !exportModalShownRef.current) {
      exportModalShownRef.current = true;
      setShowExportModal(true);
    }

    tick();
    const interval = setInterval(tick, 2000);
    return () => { destroyed = true; clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

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

  // ── Export handlers ───────────────────────────────────────────────────────
  async function handleExport(format: 'txt' | 'md') {
    if (exportingTxt) return;
    setExportingTxt(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/export-transcripts?format=${format}`);
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `transcripts-${jobId.slice(0, 8)}.${format}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Transcripts downloaded as .${format}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingTxt(false);
    }
  }

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
      setShowExportModal(false);
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

  // ── Derived ───────────────────────────────────────────────────────────────
  const status        = job.status as string;
  const transcriptDone = videos.filter(v => v.transcript_status === 'done').length;
  const totalVideos   = hydrated ? videos.length : ((job.total_video_count as number) || 0);
  const isCancellable = CANCELLABLE_STATUSES.includes(status);
  const isActive      = ACTIVE_STATUSES.has(status);

  const showFAB = status === 'awaiting_prompt' && !showExportModal;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {viewingVideo && <TranscriptModal jobId={jobId} video={viewingVideo} onClose={() => setViewingVideo(null)} />}

      {showExportModal && (
        <ExportFormatModal
          transcriptCount={transcriptDone}
          jobId={jobId}
          onDismiss={() => setShowExportModal(false)}
        />
      )}

      {/* FAB — reopens export modal if dismissed */}
      {showFAB && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={() => setShowExportModal(true)}
            title="Download transcripts"
            className="flex items-center gap-2.5 h-12 px-5 rounded-full shadow-xl border border-primary/40 bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 active:scale-95 transition-all"
          >
            <Download className="h-4 w-4" />
            <span>Download</span>
          </button>
        </div>
      )}

      <div className="min-h-screen bg-background pb-20">
        <div className="max-w-5xl mx-auto px-4 py-8">

          {/* Header */}
          <div className="flex items-start justify-between mb-8 gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                <span>📋</span><span className="capitalize font-medium">{job.source_type as string}</span>
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
          <div className="grid grid-cols-2 gap-4 mb-8">
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold">{hydrated ? videos.length : <Loader2 className="h-5 w-5 animate-spin inline text-muted-foreground" />}</div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Videos</div>
            </div>
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="text-3xl font-bold">{transcriptDone}<span className="text-muted-foreground font-normal text-lg"> / {totalVideos}</span></div>
              <div className="text-sm text-muted-foreground mt-1 font-medium">Transcripts</div>
            </div>
          </div>

          {/* Status banners */}
          {status === 'awaiting_prompt' && (
            <div className="bg-gradient-to-r from-green-500/10 to-transparent border border-green-500/30 rounded-xl p-5 mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold">✅ All transcripts extracted</p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {transcriptDone} transcript{transcriptDone !== 1 ? 's' : ''} ready to download.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" onClick={() => handleExport('txt')} disabled={exportingTxt}>
                  {exportingTxt ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />.txt</>}
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleExport('md')} disabled={exportingTxt}>
                  {exportingTxt ? 'Preparing…' : '.md'}
                </Button>
              </div>
            </div>
          )}

          {status === 'cancelled' && (
            <div className="bg-muted/40 border border-border rounded-xl p-5 mb-6">
              <p className="font-semibold">Job cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                {transcriptDone > 0 ? `${transcriptDone} transcript(s) extracted before cancellation.` : 'No transcripts were extracted.'}
              </p>
              {transcriptDone > 0 && (
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" onClick={() => handleExport('txt')} disabled={exportingTxt}>
                    {exportingTxt ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Preparing…</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Export .txt</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleExport('md')} disabled={exportingTxt}>
                    Export .md
                  </Button>
                </div>
              )}
            </div>
          )}

          {status === 'failed' && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 mb-6">
              <p className="text-red-400 font-semibold flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Job failed</p>
              <p className="text-sm text-muted-foreground mt-1">{(job.error_message as string) || 'An unknown error occurred.'}</p>
              {transcriptDone > 0 && (
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" onClick={() => handleExport('txt')} disabled={exportingTxt}>
                    {exportingTxt ? 'Preparing…' : <><Download className="h-3.5 w-3.5 mr-1.5" />Export .txt anyway</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleExport('md')} disabled={exportingTxt}>
                    Export .md
                  </Button>
                </div>
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
                const hasTx   = tStatus === 'done';
                const txError = video.transcript_error as string | null;
                return (
                  <div key={video.id as string} className="flex items-center gap-3 px-5 py-3 group hover:bg-muted/30 transition-colors">
                    <span className="text-muted-foreground text-xs w-6 text-right shrink-0 font-mono">{index + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{(video.video_title as string) || (video.video_id as string)}</p>
                      {hasTx && typeof video.transcript_word_count === 'number' && (
                        <p className="text-xs text-muted-foreground mt-0.5">{(video.transcript_word_count as number).toLocaleString()} words</p>
                      )}
                      {tStatus === 'failed' && txError && <p className="text-xs text-red-400 mt-0.5 truncate" title={txError}>{txError}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={TRANSCRIPT_VARIANTS[tStatus] ?? 'secondary'} className="text-xs">
                        {tStatus === 'done' ? '✓ Transcript' : tStatus === 'failed' ? '✗ Failed' : tStatus === 'skipped' ? '— Skipped' : tStatus === 'processing' ? 'Extracting…' : 'Pending'}
                      </Badge>
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
