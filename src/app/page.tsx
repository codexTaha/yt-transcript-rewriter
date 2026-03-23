import Link from 'next/link';
import { Youtube, Zap, Download, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Youtube className="h-5 w-5 text-primary" />
            <span>YT Rewriter</span>
          </div>
          <Link href="/auth">
            <Button size="sm">Get Started</Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 pt-24 pb-20 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground mb-6">
          <Zap className="h-3 w-3 text-primary" />
          Bulk AI transcript rewriting
        </div>

        <h1 className="text-5xl font-bold tracking-tight mb-6 text-foreground">
          Turn any YouTube channel<br />
          <span className="text-primary">into AI-rewritten scripts</span>
        </h1>

        <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-10">
          Paste a YouTube channel, playlist, or video URL. Extract all transcripts.
          Apply one master prompt. Download a bundled Markdown file with every script rewritten by AI.
        </p>

        <div className="flex items-center justify-center gap-4">
          <Link href="/auth">
            <Button size="lg">Start for free</Button>
          </Link>
          <Link href="#how-it-works">
            <Button size="lg" variant="outline">See how it works</Button>
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-4 py-20">
        <h2 className="text-2xl font-semibold text-center mb-12">How it works</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              step: '01',
              title: 'Paste a YouTube URL',
              description: 'Channel, playlist, or single video. We discover all videos and extract every available transcript automatically.'
            },
            {
              step: '02',
              title: 'Enter one master prompt',
              description: 'Write a single AI instruction — "rewrite as a blog post", "extract key insights", or anything you need. It applies to all transcripts.'
            },
            {
              step: '03',
              title: 'Download your bundle',
              description: 'Get a single Markdown file with every AI-rewritten transcript, metadata, and a table of contents. Ready to use.'
            }
          ].map((item) => (
            <div key={item.step} className="rounded-lg border border-border bg-card p-6">
              <div className="text-3xl font-bold text-primary/30 mb-3">{item.step}</div>
              <h3 className="font-semibold mb-2">{item.title}</h3>
              <p className="text-sm text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features strip */}
      <section className="border-t border-border">
        <div className="max-w-5xl mx-auto px-4 py-12 grid md:grid-cols-3 gap-6">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="text-sm font-medium">Originals preserved</div>
              <div className="text-xs text-muted-foreground">Original transcripts are never overwritten</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="text-sm font-medium">Resumable jobs</div>
              <div className="text-xs text-muted-foreground">Processing state is always saved</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Download className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="text-sm font-medium">Markdown export</div>
              <div className="text-xs text-muted-foreground">Clean bundle ready for LLMs or publishing</div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
