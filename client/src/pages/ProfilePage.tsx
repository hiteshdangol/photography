import { useParams } from 'react-router-dom';

export function ProfilePage() {
  const { slug } = useParams();
  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-14">
      <h1 className="text-display text-4xl font-semibold tracking-tight">{slug}</h1>
    </div>
  );
}
