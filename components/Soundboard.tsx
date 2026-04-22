import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { useAuth } from '@/lib/authContext';
import { useRadioStore } from '@/lib/radioStore';
import { getSupabase } from '@/lib/supabaseClient';

const DEFAULT_CATEGORIES = [
  'meme',
  'reaction',
  'laugh',
  'quote',
  'hype',
  'effect',
  'music',
  'horn',
  'voice',
  'other',
] as const;

type SortField = 'name' | 'uploadedBy' | 'category';
type Tab = 'samples' | 'live' | 'upload';

interface Sample {
  id: string;
  name: string;
  category: string;
  uploadedBy: string;
  uploadedAt: string;
  originalFileName: string | null;
}

interface SoundboardProps {
  showPublic?: boolean;
}

function formatCategoryLabel(value: string): string {
  if (!value) return 'Overig';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getFavoritesStorageKey(username: string): string {
  const normalized = username.trim().toLowerCase() || 'guest';
  return `soundboard-favorites:${normalized}`;
}

function formatUploaderLabel(value: string): string {
  const safe = value.trim();
  return safe || 'Onbekend';
}

export default function Soundboard({ showPublic }: SoundboardProps) {
  const isAdmin = useIsAdmin();
  const { userAccount } = useAuth();
  const serverUrl = useRadioStore((s) => s.serverUrl);
  const radioConnected = useRadioStore((s) => s.connected);
  const [activeTab, setActiveTab] = useState<Tab>('samples');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [categories, setCategories] = useState<string[]>([...DEFAULT_CATEGORIES]);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isMicAllowed, setIsMicAllowed] = useState<boolean | null>(null);
  const [showSoundboardPublic, setShowSoundboardPublic] = useState(showPublic ?? false);
  const [sampleName, setSampleName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('meme');
  const [sortField, setSortField] = useState<SortField>('name');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [uploaderFilter, setUploaderFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortPanelOpen, setSortPanelOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sortPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (showPublic !== undefined) {
      setShowSoundboardPublic(showPublic);
    }
  }, [showPublic]);

  useEffect(() => {
    if (!sortPanelOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (sortPanelRef.current && !sortPanelRef.current.contains(event.target as Node)) {
        setSortPanelOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [sortPanelOpen]);

  const apiBase = serverUrl || process.env.NEXT_PUBLIC_CONTROL_SERVER_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  const nickname = userAccount?.username?.trim() || '';

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(getFavoritesStorageKey(nickname));
      const parsed = stored ? JSON.parse(stored) : [];
      setFavoriteIds(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
    } catch (error) {
      console.warn('[Soundboard] Kon favorieten niet laden:', error);
      setFavoriteIds([]);
    }
  }, [nickname]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(getFavoritesStorageKey(nickname), JSON.stringify(favoriteIds));
    } catch (error) {
      console.warn('[Soundboard] Kon favorieten niet opslaan:', error);
    }
  }, [favoriteIds, nickname]);

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const uploaderOptions = useMemo(() => {
    return Array.from(new Set(samples.map((sample) => formatUploaderLabel(sample.uploadedBy)))).sort((a, b) =>
      a.localeCompare(b, 'nl', { sensitivity: 'base' }),
    );
  }, [samples]);

  const visibleSamples = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const filtered = samples.filter((sample) => {
      const uploadedBy = formatUploaderLabel(sample.uploadedBy);
      if (categoryFilter !== 'all' && sample.category !== categoryFilter) return false;
      if (uploaderFilter !== 'all' && uploadedBy !== uploaderFilter) return false;
      if (!term) return true;

      return [
        sample.name,
        uploadedBy,
        sample.category,
        sample.originalFileName ?? '',
      ].some((value) => value.toLowerCase().includes(term));
    });

    return filtered.sort((a, b) => {
      const left = sortField === 'uploadedBy' ? formatUploaderLabel(a.uploadedBy) : a[sortField];
      const right = sortField === 'uploadedBy' ? formatUploaderLabel(b.uploadedBy) : b[sortField];
      const primary = left.localeCompare(right, 'nl', { sensitivity: 'base' });
      if (primary !== 0) return primary;
      return a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' });
    });
  }, [samples, categoryFilter, uploaderFilter, searchTerm, sortField]);

  const favoriteSamples = useMemo(() => {
    return visibleSamples.filter((sample) => favoriteSet.has(sample.id));
  }, [favoriteSet, visibleSamples]);

  const regularSamples = useMemo(() => {
    return visibleSamples.filter((sample) => !favoriteSet.has(sample.id));
  }, [favoriteSet, visibleSamples]);

  const broadcastRecordingState = (active: boolean) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(active ? 'soundboard:recording-start' : 'soundboard:recording-end'));
  };

  const applySamplePayload = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const record = payload as { samples?: unknown; categories?: unknown };

    if (Array.isArray(record.samples)) {
      setSamples(record.samples as Sample[]);
    }

    if (Array.isArray(record.categories) && record.categories.every((item) => typeof item === 'string')) {
      setCategories(record.categories as string[]);
      if (!record.categories.includes(selectedCategory)) {
        setSelectedCategory((record.categories[0] as string) || 'other');
      }
    }
  };

  const refreshSamples = async () => {
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('soundboard:list');
    }

    try {
      const adminToken = localStorage.getItem('radio_admin_token') || '';
      const params = new URLSearchParams();
      if (nickname) params.set('nickname', nickname);
      const response = await fetch(`${apiBase}/api/soundboard/samples${params.toString() ? `?${params.toString()}` : ''}`, {
        headers: adminToken ? { 'X-Admin-Token': adminToken } : undefined,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json().catch(() => ({}));
      applySamplePayload(data);
    } catch (err) {
      console.warn('[Soundboard] HTTP sample refresh failed:', err);
    }
  };

  useEffect(() => {
    const socket = getSocket();
    const handleList = (list: Sample[]) => {
      setSamples(list);
    };

    socket.on('soundboard:list', handleList);
    void refreshSamples();

    const retryTimeout = setTimeout(() => {
      if (samples.length === 0) {
        void refreshSamples();
      }
    }, 2000);

    if (showPublic === undefined) {
      const loadSoundboardSetting = async () => {
        try {
          const { data, error } = await getSupabase()
            .from('settings')
            .select('show_soundboard_public')
            .eq('id', 1)
            .single();
          if (!error && data) {
            setShowSoundboardPublic(data.show_soundboard_public ?? false);
          }
        } catch (err) {
          console.error('[Soundboard] Failed to load setting:', err);
        }
      };
      void loadSoundboardSetting();
    }

    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' as PermissionName }).then((result) => {
        setIsMicAllowed(result.state === 'granted');
        result.onchange = () => {
          setIsMicAllowed(result.state === 'granted');
        };
      }).catch(() => {});
    }

    return () => {
      socket.off('soundboard:list', handleList);
      clearTimeout(retryTimeout);
    };
  }, [apiBase, nickname, radioConnected, showPublic, samples.length]);

  const requestMicPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setIsMicAllowed(true);
    } catch (err) {
      console.error('Microfoon weigering:', err);
      setIsMicAllowed(false);
      alert('Microfoon toegang is geweigerd. Zet dit aan in je browser instellingen.');
    }
  };

  const playSample = (id: string) => {
    const socket = getSocket();
    if (socket) {
      const adminToken = localStorage.getItem('radio_admin_token') || '';
      socket.emit('soundboard:play', { sampleId: id, token: adminToken });
    }
  };

  const toggleFavorite = (sampleId: string) => {
    setFavoriteIds((current) =>
      current.includes(sampleId) ? current.filter((id) => id !== sampleId) : [...current, sampleId],
    );
  };

  const startRecording = async () => {
    if (isRecording || isUploading) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

        if (audioChunksRef.current.length > 0) {
          await uploadVoiceMessage(audioBlob);
        } else {
          setIsRecording(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setIsMicAllowed(true);
      broadcastRecordingState(true);
    } catch (err) {
      console.error('Microfoon toegang geweigerd:', err);
      setIsMicAllowed(false);
      alert('Microfoon toegang is vereist. Klik op de microfoon knop om toestemming te geven.');
      setIsRecording(false);
      broadcastRecordingState(false);
    }
  };

  const stopRecording = () => {
    if (!isRecording && mediaRecorderRef.current?.state !== 'recording') return;
    broadcastRecordingState(false);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (mediaRecorderRef.current?.stream) {
      mediaRecorderRef.current.stream.getTracks().forEach((track) => {
        if (track.readyState === 'live') {
          track.stop();
        }
      });
    }
  };

  const uploadVoiceMessage = async (blob: Blob) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'voice-message.webm');
      formData.append('nickname', userAccount?.username || 'Onbekend');

      const adminToken = localStorage.getItem('radio_admin_token') || '';
      const response = await fetch(`${apiBase}/api/soundboard/voice`, {
        method: 'POST',
        headers: {
          'X-Admin-Token': adminToken,
        },
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Server fout ${response.status}`);
      }
    } catch (err) {
      console.error('Upload fout:', err);
      alert('Kon bericht niet verzenden via de API.');
    } finally {
      setIsUploading(false);
      setIsRecording(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const trimmedName = sampleName.trim();
    if (!trimmedName) {
      alert('Geef de sample eerst een naam.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('audio', file);
      formData.append('nickname', userAccount?.username || 'Onbekend');
      formData.append('sampleName', trimmedName);
      formData.append('category', selectedCategory);

      const adminToken = localStorage.getItem('radio_admin_token') || '';
      const response = await fetch(`${apiBase}/api/soundboard/upload`, {
        method: 'POST',
        headers: {
          'X-Admin-Token': adminToken,
        },
        body: formData,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || `Upload mislukt (${response.status})`);
      }

      setSampleName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      setActiveTab('samples');
      setTimeout(() => {
        void refreshSamples();
      }, 500);
    } catch (err) {
      console.error('Fout bij uploaden sample:', err);
      alert(err instanceof Error ? err.message : 'Upload mislukt.');
    } finally {
      setIsUploading(false);
    }
  };

  if (!isAdmin && !showSoundboardPublic) return null;

  const sampleTabs: Array<{ id: Tab; label: string }> = [
    { id: 'samples', label: 'Samples' },
    { id: 'live', label: 'Live' },
    { id: 'upload', label: 'Upload' },
  ];

  const renderSampleCard = (sample: Sample, highlighted = false) => {
    const isFavorite = favoriteSet.has(sample.id);
    const uploadedBy = formatUploaderLabel(sample.uploadedBy);

    return (
      <div
        key={`${highlighted ? 'favorite-' : 'sample-'}${sample.id}`}
        role="button"
        tabIndex={0}
        onClick={() => playSample(sample.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            playSample(sample.id);
          }
        }}
        className={`group relative z-0 overflow-hidden rounded-lg border px-2.5 py-2 text-left text-gray-300 transition-all hover:border-violet-400 hover:bg-violet-600 hover:text-white active:scale-95 ${
          highlighted
            ? 'border-pink-500/20 bg-pink-500/5'
            : 'border-gray-800 bg-gray-900/85'
        }`}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleFavorite(sample.id);
          }}
          className={`absolute right-2 top-2 z-10 rounded-full px-1.5 py-0.5 text-xs transition ${
            isFavorite
              ? 'bg-pink-500/20 text-pink-300 hover:bg-pink-500/30'
              : 'bg-black/30 text-gray-500 hover:bg-black/50 hover:text-pink-200'
          }`}
          aria-label={isFavorite ? `Verwijder ${sample.name} uit favorieten` : `Voeg ${sample.name} toe aan favorieten`}
        >
          {isFavorite ? '♥' : '♡'}
        </button>
        <div className="relative z-0 space-y-1 pr-7">
          <p className="truncate text-xs font-semibold">{sample.name}</p>
          <div className="flex flex-wrap gap-1 text-[9px] text-gray-500 group-hover:text-violet-100/90">
            <span className="rounded-full bg-black/20 px-1.5 py-0.5">{formatCategoryLabel(sample.category)}</span>
            <span className="rounded-full bg-black/20 px-1.5 py-0.5">door {uploadedBy}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-xl border border-gray-800 bg-gray-900 p-3 shadow-xl sm:p-4">
      <div className="flex items-center justify-between border-b border-gray-800 pb-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Soundboard
        </h2>
        <div className="flex items-center gap-2">
          {isAdmin && isMicAllowed === false && (
            <button
              onClick={requestMicPermission}
              className="rounded border border-red-500/40 bg-red-500/20 px-2 py-1 text-[10px] text-red-400 transition hover:bg-red-500/30"
            >
              Mic Toestaan
            </button>
          )}
          <span className="text-[10px] text-gray-500">
            {samples.length} {samples.length === 1 ? 'sample' : 'samples'}
          </span>
        </div>
      </div>

      <div className="shrink-0 rounded-md border border-gray-800 bg-gray-950/50 p-1">
        <div className="flex gap-1">
          {sampleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                activeTab === tab.id
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'live' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-gray-800 bg-gray-950/40 p-3">
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-[11px] text-gray-300">
            Houd de knop ingedrukt om op te nemen. Zodra je loslaat, wordt de opname meteen afgespeeld.
          </div>
          <button
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            className={`relative flex w-full items-center justify-center gap-3 rounded-2xl px-4 py-4 text-sm font-bold shadow-lg transition-all select-none ${
              isRecording
                ? 'animate-pulse bg-red-600 text-white scale-[0.98]'
                : isUploading
                  ? 'cursor-wait bg-gray-800 text-gray-500'
                  : 'bg-gradient-to-br from-violet-600 to-violet-700 text-white hover:from-violet-500 hover:to-violet-600 active:scale-95'
            }`}
            disabled={isUploading}
          >
            <span className="text-xl">{isRecording ? '⏹' : (isMicAllowed ? '🎤' : '🎙️')}</span>
            <div className="min-w-0 text-left">
              <div className="leading-tight">{isRecording ? 'Aan het opnemen...' : 'Live Inspreken'}</div>
              <div className="text-[10px] font-normal opacity-70">
                {isRecording ? 'Laat los om af te spelen' : 'Inhouden voor opname'}
              </div>
            </div>
          </button>
        </div>
      )}

      {activeTab === 'samples' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-800 bg-gray-950/30 md:overflow-visible">
          <div className="shrink-0 space-y-2 border-b border-gray-800 p-3 md:relative md:z-10">
            <input
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Zoek samples, uploader of categorie..."
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-white outline-none transition focus:border-violet-500"
            />

            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-gray-800/60 px-2 py-1 text-[10px] text-gray-300">
                {visibleSamples.length} zichtbaar
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFavoritesOpen((prev) => !prev)}
                  className={`rounded-md border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                    favoritesOpen
                      ? 'border-pink-500/60 bg-pink-500/20 text-pink-200'
                      : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'
                  }`}
                >
                  Favorieten
                </button>
                <div ref={sortPanelRef} className="relative z-40">
                  <button
                    type="button"
                    onClick={() => setSortPanelOpen((prev) => !prev)}
                    className={`rounded-md border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                      sortPanelOpen
                        ? 'border-violet-500/60 bg-violet-500/20 text-violet-200'
                        : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600 hover:text-white'
                    }`}
                  >
                    Sorteren
                  </button>
                  {sortPanelOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-gray-700 bg-gray-900 p-3 shadow-2xl shadow-black/50">
                      <div className="grid gap-3">
                        <label className="space-y-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Sortering</span>
                          <select
                            value={sortField}
                            onChange={(event) => setSortField(event.target.value as SortField)}
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-white outline-none transition focus:border-violet-500"
                          >
                            <option value="name">Naam</option>
                            <option value="uploadedBy">Uploader</option>
                            <option value="category">Categorie</option>
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Filter op categorie</span>
                          <select
                            value={categoryFilter}
                            onChange={(event) => setCategoryFilter(event.target.value)}
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-white outline-none transition focus:border-violet-500"
                          >
                            <option value="all">Alle categorieen</option>
                            {categories.map((category) => (
                              <option key={category} value={category}>
                                {formatCategoryLabel(category)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Filter op uploader</span>
                          <select
                            value={uploaderFilter}
                            onChange={(event) => setUploaderFilter(event.target.value)}
                            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-white outline-none transition focus:border-violet-500"
                          >
                            <option value="all">Alle uploaders</option>
                            {uploaderOptions.map((uploader) => (
                              <option key={uploader} value={uploader}>
                                {uploader}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="flex items-center justify-between gap-2 border-t border-gray-800 pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSortField('name');
                              setCategoryFilter('all');
                              setUploaderFilter('all');
                            }}
                            className="rounded-md border border-gray-700 px-2.5 py-1.5 text-[10px] font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white"
                          >
                            Reset filters
                          </button>
                          <button
                            type="button"
                            onClick={() => setSortPanelOpen(false)}
                            className="rounded-md bg-violet-600 px-2.5 py-1.5 text-[10px] font-semibold text-white transition hover:bg-violet-500"
                          >
                            Sluiten
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => { void refreshSamples(); }}
                  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-[10px] font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white"
                  title="Ververs"
                >
                  Ververs
                </button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-3">
              {favoritesOpen && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-pink-300">Jouw favorieten</h4>
                    <span className="text-[10px] text-pink-200/80">{favoriteSamples.length}</span>
                  </div>
                  {favoriteSamples.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {favoriteSamples.map((sample) => renderSampleCard(sample, true))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-pink-500/20 bg-pink-500/5 py-4 text-center">
                      <p className="text-[10px] italic text-pink-100/70">Nog geen favorieten geselecteerd.</p>
                    </div>
                  )}
                </section>
              )}

              <div className="grid grid-cols-2 gap-2">
                {regularSamples.map((sample) => renderSampleCard(sample))}
              </div>

              {visibleSamples.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-800 bg-gray-950/30 py-8 text-center">
                  <p className="text-xs italic text-gray-600">Geen samples gevonden voor deze selectie.</p>
                  <button
                    onClick={() => {
                      setSearchTerm('');
                      setCategoryFilter('all');
                      setUploaderFilter('all');
                      setFavoritesOpen(false);
                      void refreshSamples();
                    }}
                    className="mt-2 text-[10px] text-violet-400 underline hover:text-violet-300"
                  >
                    Filters wissen en opnieuw laden
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'upload' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-gray-800 bg-gray-950/40 p-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Nieuwe sample</h3>
            <p className="mt-1 text-[11px] text-gray-500">Geef je sample eerst een naam en categorie mee.</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Naam</span>
              <input
                type="text"
                value={sampleName}
                onChange={(event) => setSampleName(event.target.value.slice(0, 80))}
                placeholder="Bijv. Airhorn hard"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-violet-500"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Categorie</span>
              <select
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-violet-500"
              >
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {formatCategoryLabel(category)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-sm font-bold text-gray-200 shadow-md transition-all hover:border-gray-500 hover:bg-gray-750 active:scale-95"
            disabled={isUploading}
          >
            <span className="text-xl">📤</span>
            <div className="text-left">
              <div className="leading-tight">{isUploading ? 'Bezig met laden...' : 'Bestand Kiezen'}</div>
              <div className="text-[10px] font-normal text-gray-400">Audio, WhatsApp of opnamebestand</div>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="audio/*"
              className="hidden"
            />
          </button>
        </div>
      )}
    </div>
  );
}
