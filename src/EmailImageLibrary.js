// #480: Email Image Library. Staff upload images once (public `email-images`
// bucket + `email_images` catalogue, migration 20261104_email_images.sql) and
// insert them into a campaign from Compose Message (the image button in the
// editor opens EmailImagePicker). The bucket is public because email clients
// fetch <img src> with no session, so nothing private belongs here.

import React, { useState, useEffect, useCallback } from 'react';
import { Upload, Trash2, Copy, Check, X, Image as ImageIcon } from 'lucide-react';
import { supabase } from './supabaseClient';
import { formatUserError } from './errorMessage';

export const EMAIL_IMAGES_BUCKET = 'email-images';
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const readDimensions = (file) => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const img = new window.Image();
  img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
  img.onerror = () => { resolve({ width: null, height: null }); URL.revokeObjectURL(url); };
  img.src = url;
});

export async function fetchEmailImages() {
  const { data, error } = await supabase
    .from('email_images')
    .select('id, name, storage_path, public_url, size_bytes, width, height, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data || [];
}

export async function uploadEmailImage(file, userId) {
  if (!ACCEPT.split(',').includes(file.type)) throw new Error('Use a PNG, JPG, GIF or WebP image.');
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is ${fmtSize(file.size)}; the limit is 5 MB.`);
  const ext = (file.name.split('.').pop() || 'img').toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
  const path = `${Date.now()}-${base}.${ext}`;
  const { error: upErr } = await supabase.storage.from(EMAIL_IMAGES_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) throw upErr;
  const { data: pub } = supabase.storage.from(EMAIL_IMAGES_BUCKET).getPublicUrl(path);
  const dims = await readDimensions(file);
  const { data, error } = await supabase.from('email_images').insert({
    name: file.name.replace(/\.[^.]+$/, ''),
    storage_path: path,
    public_url: pub.publicUrl,
    mime_type: file.type,
    size_bytes: file.size,
    width: dims.width,
    height: dims.height,
    uploaded_by: userId || null,
  }).select('id, name, storage_path, public_url, size_bytes, width, height, created_at').single();
  if (error) {
    await supabase.storage.from(EMAIL_IMAGES_BUCKET).remove([path]);
    throw error;
  }
  return data;
}

async function deleteEmailImage(row) {
  const { error } = await supabase.from('email_images').delete().eq('id', row.id);
  if (error) throw error;
  await supabase.storage.from(EMAIL_IMAGES_BUCKET).remove([row.storage_path]);
}

// Upload control + grid, shared by the library page and the picker.
function useLibrary(userId) {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setImages(await fetchEmailImages()); setError(''); } catch (err) { setError(formatUserError(err)); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = async (files) => {
    setUploading(true);
    setError('');
    const added = [];
    for (const f of Array.from(files || [])) {
      try { added.push(await uploadEmailImage(f, userId)); } catch (err) { setError(formatUserError(err)); }
    }
    if (added.length) setImages((prev) => [...added.reverse(), ...prev]);
    setUploading(false);
    return added;
  };
  return { images, setImages, loading, error, setError, uploading, upload };
}

function UploadButton({ uploading, onFiles, label = 'Upload images' }) {
  return (
    <label className={`inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-blue-700 ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
      <Upload size={15} />{uploading ? 'Uploading…' : label}
      <input type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
    </label>
  );
}

export default function EmailImageLibrary({ userId }) {
  const { images, setImages, loading, error, setError, uploading, upload } = useLibrary(userId);
  const [copied, setCopied] = useState(null);

  const copy = async (img) => {
    try { await navigator.clipboard.writeText(img.public_url); setCopied(img.id); setTimeout(() => setCopied(null), 1500); } catch { window.prompt('Copy this link:', img.public_url); }
  };
  const remove = async (img) => {
    if (!window.confirm(`Delete "${img.name}"? Emails already sent with it will show a broken image.`)) return;
    try { await deleteEmailImage(img); setImages((prev) => prev.filter((x) => x.id !== img.id)); } catch (err) { setError(formatUserError(err)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Email Image Library</h3>
          <p className="text-sm text-gray-500">PNG, JPG, GIF or WebP up to 5 MB. Insert them in Compose Message with the image button in the editor. Images are public links, so don't upload anything private.</p>
        </div>
        <UploadButton uploading={uploading} onFiles={upload} />
      </div>
      {error && <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading images…</p>
      ) : images.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-lg">
          <ImageIcon size={36} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-500">No images yet. Upload one to use it in an email.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {images.map((img) => (
            <div key={img.id} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
              <div className="aspect-video bg-gray-50 flex items-center justify-center">
                <img src={img.public_url} alt={img.name} className="max-h-full max-w-full object-contain" loading="lazy" />
              </div>
              <div className="p-2">
                <p className="text-sm font-medium text-gray-900 truncate" title={img.name}>{img.name}</p>
                <p className="text-xs text-gray-500">{[img.width && img.height ? `${img.width}×${img.height}` : null, fmtSize(img.size_bytes)].filter(Boolean).join(' · ')}</p>
                <div className="flex gap-1 mt-2">
                  <button type="button" onClick={() => copy(img)} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 border border-gray-300 rounded text-xs text-gray-700 hover:bg-gray-50">
                    {copied === img.id ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy link</>}
                  </button>
                  <button type="button" onClick={() => remove(img)} className="px-2 py-1 border border-red-200 rounded text-red-600 hover:bg-red-50" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal: pick a library image (or upload one) to insert into the email.
export function EmailImagePicker({ userId, onPick, onClose }) {
  const { images, loading, error, uploading, upload } = useLibrary(userId);
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold text-gray-900">Insert an image</h3>
          <div className="flex items-center gap-2">
            <UploadButton uploading={uploading} label="Upload new" onFiles={async (f) => { const added = await upload(f); if (added.length === 1) onPick(added[0]); }} />
            <button type="button" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>
        </div>
        <div className="p-5 overflow-y-auto">
          {error && <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>}
          {loading ? (
            <p className="text-sm text-gray-500">Loading images…</p>
          ) : images.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-10">The library is empty. Upload an image to insert it.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {images.map((img) => (
                <button key={img.id} type="button" onClick={() => onPick(img)} className="border border-gray-200 rounded-lg overflow-hidden text-left hover:border-blue-500 hover:ring-2 hover:ring-blue-200">
                  <div className="aspect-video bg-gray-50 flex items-center justify-center">
                    <img src={img.public_url} alt={img.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                  </div>
                  <p className="text-xs font-medium text-gray-800 truncate px-2 py-1.5">{img.name}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
