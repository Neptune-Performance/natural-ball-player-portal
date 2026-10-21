import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

// Fetched once per page session and cached at module scope, so opening the
// workout/program editor (or both, or the same one repeatedly) never
// re-fetches the ~1,275-row library more than once. Resets only on a full
// page reload.
let cachedVideos = null;
let inFlightPromise = null;

// PostgREST caps an unbounded select at 1,000 rows. The library is larger
// than that (~1,275 and growing), so a plain .select() silently returned a
// truncated list and the name input's "no video for this exercise yet" hint
// was wrong for every exercise past the cap. Page through explicitly.
const PAGE_SIZE = 1000;

async function fetchExerciseVideos() {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('exercise_videos')
      .select('name, name_key, video_url')
      .order('name_key')
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      // A failed lookup must never block a coach from saving a workout — the
      // name input just falls back to a plain text field with no suggestions.
      // Keep whatever pages already arrived rather than throwing them away.
      console.error('exerciseVideos: fetch failed:', error);
      return all;
    }
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}

// #459: the All videos screen rewrites library rows; drop the cache so the
// next editor open sees the new links instead of this session's stale copy.
export function invalidateExerciseVideos() {
  cachedVideos = null;
  inFlightPromise = null;
}

export function useExerciseVideos() {
  const [videos, setVideos] = useState(cachedVideos || []);
  const [loading, setLoading] = useState(cachedVideos === null);

  useEffect(() => {
    if (cachedVideos !== null) {
      setVideos(cachedVideos);
      setLoading(false);
      return;
    }
    if (!inFlightPromise) inFlightPromise = fetchExerciseVideos();

    let cancelled = false;
    inFlightPromise.then((rows) => {
      cachedVideos = rows;
      inFlightPromise = null;
      if (!cancelled) {
        setVideos(rows);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const byKey = {};
  videos.forEach((v) => { byKey[v.name_key] = v; });

  return { videos, byKey, loading };
}
