'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Youtube, ArrowRight, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const YOUTUBE_URL_PATTERN = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;

export default function NewJobPage() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [urlError, setUrlError] = useState('');

  function validateUrl(value: string): boolean {
    if (!value.trim()) {
      setUrlError('Please enter a YouTube URL.');
      return false;
    }
    if (!YOUTUBE_URL_PATTERN.test(value.trim())) {
      setUrlError('That does not look like a valid YouTube URL.');
      return false;
    }
    setUrlError('');
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateUrl(url)) return;

    setLoading(true);
    try {
      // Step 1: Create the job
      const createRes = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_url: url.trim() })
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error);

      const jobId = createData.data.job_id;

      // Step 2: Trigger discovery (non-blocking — redirect immediately)
      fetch(`/api/jobs/${jobId}/discover`, { method: 'POST' }).catch(() => {});

      router.push(`/jobs/${jobId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create job';
      toast.error(message);
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">New Job</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste any YouTube channel, playlist, or video URL.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              YouTube URL
            </label>
            <div className="relative">
              <Youtube className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="url"
                placeholder="https://youtube.com/@channel  or  /playlist?list=...  or  /watch?v=..."
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlError) validateUrl(e.target.value);
                }}
                className="pl-10"
                autoFocus
              />
            </div>
            {urlError && (
              <div className="flex items-center gap-1.5 mt-1.5 text-xs text-red-400">
                <AlertCircle className="h-3 w-3" />
                {urlError}
              </div>
            )}
          </div>

          <div className="rounded-md bg-secondary/50 border border-border p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Supported formats:</p>
            <p>• Channel — https://youtube.com/@channelname</p>
            <p>• Playlist — https://youtube.com/playlist?list=PLxxx</p>
            <p>• Video — https://youtube.com/watch?v=xxxxx</p>
          </div>

          <Button type="submit" className="w-full" loading={loading} size="lg">
            {!loading && <ArrowRight className="h-4 w-4 mr-2" />}
            {loading ? 'Creating job…' : 'Discover Videos'}
          </Button>
        </form>
      </div>
    </div>
  );
}
