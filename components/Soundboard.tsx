import React, { useState, useEffect, useRef } from 'react';
import { getSocket } from '@/lib/socket';
import { useIsAdmin } from '@/lib/useIsAdmin';
import { useAuth } from '@/lib/authContext';

interface Sample {
  id: string;
  name: string;
}

export default function Soundboard() {
  const isAdmin = useIsAdmin();
  const { userAccount } = useAuth();
  const [samples, setSamples] = useState<Sample[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('soundboard:list');
    socket.on('soundboard:list', (list: Sample[]) => {
      setSamples(list);
    });

    return () => {
      socket.off('soundboard:list');
    };
  }, []);

  const playSample = (id: string) => {
    const socket = getSocket();
    if (socket) {
      socket.emit('soundboard:play', { sampleId: id });
    }
  };

  const startRecording = async () => {
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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());
        
        if (audioChunksRef.current.length > 0) {
          await uploadVoiceMessage(audioBlob);
        }
        setIsRecording(false);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Microfoon toegang geweigerd:', err);
      alert('Microfoon toegang is vereist.');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const uploadVoiceMessage = async (blob: Blob) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'voice-message.webm');
      const nickname = userAccount?.username || 'Onbekend';
      formData.append('nickname', nickname);

      const adminToken = localStorage.getItem('radio_admin_token') || '';
      
      // We praten nu tegen de interne Next.js API route
      const response = await fetch('/api/soundboard/voice', {
        method: 'POST',
        headers: { 
          'X-Admin-Token': adminToken,
        },
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Server fout ${response.status}`);
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

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('audio', file);
      const nickname = userAccount?.username || 'Onbekend';
      formData.append('nickname', nickname);

      const adminToken = localStorage.getItem('radio_admin_token') || '';
      
      const response = await fetch('/api/soundboard/upload', {
        method: 'POST',
        headers: { 
          'X-Admin-Token': adminToken,
        },
        body: formData,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Upload mislukt');
      
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error('Fout bij uploaden sample:', err);
      alert(err instanceof Error ? err.message : 'Upload mislukt.');
    } finally {
      setIsUploading(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div className="flex flex-col gap-5 p-4 bg-gray-900 rounded-xl border border-gray-800 shadow-xl">
      <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
        <span className="text-xl">🔊</span>
        <h3 className="text-lg font-bold text-white tracking-tight">Soundboard & Interactie</h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={stopRecording}
          onTouchStart={startRecording}
          onTouchEnd={stopRecording}
          className={`relative flex items-center justify-center gap-3 px-4 py-4 rounded-xl text-sm font-bold transition-all shadow-lg select-none ${
            isRecording 
              ? 'bg-red-600 animate-pulse text-white scale-[0.98]' 
              : isUploading 
                ? 'bg-gray-800 text-gray-500 cursor-wait'
                : 'bg-gradient-to-br from-violet-600 to-violet-700 hover:from-violet-500 hover:to-violet-600 text-white active:scale-95'
          }`}
          disabled={isUploading}
        >
          <span className="text-xl">{isRecording ? '⏹' : '🎤'}</span>
          <div className="text-left">
            <div className="block leading-tight">{isRecording ? 'Aan het opnemen...' : 'Live Inspreken'}</div>
            <div className="text-[10px] font-normal opacity-70">{isRecording ? 'Laat los om te verzenden' : 'Houd de knop ingedrukt'}</div>
          </div>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-3 px-4 py-4 bg-gray-800 hover:bg-gray-750 text-gray-200 rounded-xl text-sm font-bold transition-all border border-gray-700 hover:border-gray-500 active:scale-95 shadow-md"
          disabled={isUploading}
        >
          <span className="text-xl">📤</span>
          <div className="text-left">
            <div className="block leading-tight">{isUploading ? 'Bezig met laden...' : 'Sample Uploaden'}</div>
            <div className="text-[10px] font-normal text-gray-400">Audio, WhatsApp, etc. (Max 10s)</div>
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

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-gray-500 px-1">Beschikbare Samples</h4>
          <span className="text-[10px] text-gray-600 bg-gray-800/50 px-2 py-0.5 rounded-full">{samples.length} tracks</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {samples.map((sample) => (
            <button
              key={sample.id}
              onClick={() => playSample(sample.id)}
              className="group relative px-3 py-2.5 bg-gray-850 hover:bg-violet-600 text-gray-300 hover:text-white rounded-lg text-xs font-semibold transition-all border border-gray-800 hover:border-violet-400 active:scale-95 overflow-hidden"
            >
              <span className="relative z-10 truncate block">{sample.name}</span>
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
          {samples.length === 0 && (
            <div className="col-span-full py-8 text-center bg-gray-950/30 rounded-lg border border-dashed border-gray-800">
              <p className="text-xs text-gray-600 italic">Geen samples gevonden in data/samples</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
