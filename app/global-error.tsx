'use client';

import React from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log the error to console
  React.useEffect(() => {
    console.error('Global Error:', error);
  }, [error]);

  return (
    <html lang="nl">
      <body className="bg-gray-950 text-white min-h-screen flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <h2 className="text-3xl font-bold text-red-500">Oeps! Er ging iets mis</h2>
          <p className="text-gray-400">
            Er is een onverwachte fout opgetreden in de applicatie.
          </p>
          <div className="bg-gray-900 p-4 rounded-lg border border-gray-800 text-left overflow-auto max-h-40">
            <code className="text-xs text-fuchsia-400">{error?.message || 'Onbekende fout'}</code>
          </div>
          <button
            onClick={() => reset()}
            className="w-full py-3 bg-violet-600 hover:bg-violet-500 rounded-lg font-semibold transition"
          >
            Probeer het opnieuw
          </button>
        </div>
      </body>
    </html>
  );
}
