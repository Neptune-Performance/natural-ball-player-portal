// Server-to-server only. NBP_MECHANICS_SECRET is shared with the Mechanics server,
// never a REACT_APP_ variable and never sent to either application's browser.
const { timingSafeEqual, createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { createClient } = require('@supabase/supabase-js');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = value => createHash('sha256').update(value).digest();

function authorized(req, secret) {
  return typeof req.headers.authorization === 'string' && timingSafeEqual(hash(req.headers.authorization), hash(`Bearer ${secret}`));
}

function decodeDelivery(body) {
  if (!body || !['deliveryId', 'reportId', 'athleteId', 'senderId'].every(key => uuid(body[key])) ||
      typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint) ||
      typeof body.finalizedAt !== 'string' || !Number.isFinite(Date.parse(body.finalizedAt)) ||
      typeof body.payloadGzip !== 'string' || body.payloadGzip.length > 4_000_000) throw new Error('Invalid delivery');
  const payload = JSON.parse(gunzipSync(Buffer.from(body.payloadGzip, 'base64'), { maxOutputLength: 32_000_000 }).toString('utf8'));
  if (payload?.schema !== 'mechanics-session-report-v1' || payload.kind !== 'mechanics-session' ||
      !uuid(payload.sessionId) || typeof payload.athleteName !== 'string' || !payload.athleteName.trim() ||
      typeof payload.captureDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.captureDate) ||
      typeof payload.level !== 'string' || typeof payload.notes !== 'string' ||
      !Array.isArray(payload.groups) || !payload.groups.length || !Array.isArray(payload.excludedPitchNumbers) ||
      !payload.referenceReview || !payload.groups.every(g => g && typeof g.id === 'string' &&
        typeof g.notes === 'string' && Array.isArray(g.pitchNumbers) && Array.isArray(g.metrics))) throw new Error('Invalid report');
  return payload;
}

// Dependency injection keeps auth/failure behavior testable without touching live athletes.
function createHandler(makeClient = createClient, env = process.env) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
    if (!env.NBP_MECHANICS_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'Integration not configured' });
    if (!authorized(req, env.NBP_MECHANICS_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    const db = makeClient(env.SUPABASE_URL || env.REACT_APP_SUPABASE_URL || 'https://cjilkqzifyhssbsiqgfu.supabase.co', env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
    try {
      if (req.method === 'GET') {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (q.length < 2 || q.length > 100) return res.status(400).json({ error: 'Search requires 2–100 characters' });
        // Literal substring match, not client-supplied PostgREST syntax or wildcard patterns.
        const pattern = q.replace(/[\\%_]/g, '\\$&');
        const { data, error } = await db.from('users').select('id,full_name,player_profiles:player_profiles!player_profiles_user_id_fkey(grad_year,position)')
          .eq('role', 'player').ilike('full_name', `%${pattern}%`).order('full_name').order('id').limit(26);
        if (error) return res.status(502).json({ error: 'Athlete search unavailable' });
        return res.status(200).json({ athletes: (data || []).slice(0, 25).map(row => {
          const profile = Array.isArray(row.player_profiles) ? row.player_profiles[0] : row.player_profiles;
          return { id: row.id, name: row.full_name, detail: [profile?.grad_year ? `Class of ${profile.grad_year}` : '', profile?.position, `ID ${row.id.slice(0, 8)}`].filter(Boolean).join(' · ') };
        }), hasMore: (data || []).length > 25 });
      }
      let body, payload;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; payload = decodeDelivery(body); }
      catch { return res.status(400).json({ error: 'Invalid report delivery' }); }
      const { data, error } = await db.rpc('receive_mechanics_report', { p_delivery: body.deliveryId, p_report: body.reportId,
        p_athlete: body.athleteId, p_sender: body.senderId, p_fingerprint: body.fingerprint, p_finalized_at: body.finalizedAt, p_payload: payload });
      if (error) return res.status(error.code === 'P0002' ? 404 : error.code === '23505' ? 409 : 502).json({ error: 'Report delivery could not be completed' });
      if (!uuid(data)) return res.status(502).json({ error: 'Missing delivery receipt' });
      return res.status(200).json({ reportId: data });
    } catch { return res.status(502).json({ error: 'NBP report integration unavailable' }); }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.decodeDelivery = decodeDelivery;
