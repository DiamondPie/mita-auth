import { CommentSection } from '@/components/CommentSection';

export default function Home() {
  return (
    <main>
      <header>
        <h1>Mita playground</h1>
        <p className="subtitle">Next.js App Router · @mita-auth/react</p>
      </header>
      <CommentSection />
    </main>
  );
}
