import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white p-4">
      <h2 className="text-4xl font-bold mb-4">Pagina niet gevonden</h2>
      <p className="text-gray-400 mb-8 text-center">Sorry, de pagina die je zoekt bestaat niet of is verplaatst.</p>
      <Link 
        href="/"
        className="px-6 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg font-semibold transition"
      >
        Terug naar home
      </Link>
    </div>
  );
}
