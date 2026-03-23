# YT Transcript Rewriter

A web app that extracts YouTube transcripts in bulk and rewrites them using AI under one master prompt.

**Stack:** Next.js 14 (App Router) · TypeScript · Supabase · Vercel · Claude API

---

## How it works

1. Paste a YouTube channel, playlist, or video URL
2. The app discovers all videos and extracts all available transcripts
3. You enter one master prompt (e.g. “rewrite as a blog post”)
4. The AI rewrites every transcript using that prompt
5. Download a bundled Markdown file with all rewritten scripts

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/codexTaha/yt-transcript-rewriter.git
cd yt-transcript-rewriter
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
# Fill in all values in .env.local
```

Required variables:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project settings |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings |
| `YOUTUBE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com) → YouTube Data API v3 |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| `AI_MODEL` | Default: `claude-3-5-sonnet-20241022` |

### 3. Set up Supabase

Run migrations in Supabase SQL Editor in order:

```
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_storage_buckets.sql
```

Or use Supabase CLI:

```bash
npx supabase db push
```

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Project Structure

```
src/
├── app/
│   ├── (app)/              # Authenticated routes (dashboard, jobs)
│   ├── api/                # API routes
│   │   ├── jobs/           # Job CRUD + discovery + prompt
│   │   ├── worker/         # Extract + rewrite workers + pumps
│   │   └── auth/           # Auth actions
│   ├── auth/               # Sign in / sign up page
│   └── page.tsx            # Landing page
├── components/
│   ├── ui/                 # Button, Badge, Card, Input, Textarea
│   └── layout/             # Navbar
├── lib/
│   ├── supabase/           # client, server, admin, middleware helpers
│   ├── youtube/            # URL validation, discovery, transcript fetch
│   ├── ai/                 # AI client abstraction, chunker
│   └── export/             # Bundle assembler
└── types/
    ├── database.ts         # All DB types + schema
    └── index.ts            # Re-exports + API response types
```

---

## Implementation Phases

- [x] **Phase 1** — Foundation (repo, schema, auth, pages, types)
- [ ] **Phase 2** — URL validation + YouTube discovery
- [ ] **Phase 3** — Transcript extraction worker
- [ ] **Phase 4** — Prompt submission + AI rewrite worker
- [ ] **Phase 5** — Export generation + download
- [ ] **Phase 6** — Error handling + resilience
- [ ] **Phase 7** — Deployment + production hardening

---

## License

MIT
