/**
 * Trial License Server — /api/validate
 * 
 * POST { hwid, fingerprint, app_id }
 * 
 * - New user → creates trial (configurable hours)
 * - Existing trial → checks expiry
 * - Active license → confirms
 * - Banned → 403
 * - Expired → 402
 * - Kill command pending → returns kill: true
 * - Wipe command pending → returns wipe: true
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Default trial duration in hours (can be overridden per app_id in DB)
const DEFAULT_TRIAL_HOURS = 12;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { hwid, fingerprint, app_id } = req.body || {};

  if (!hwid) {
    return res.status(400).json({ error: 'HWID is required' });
  }

  const appId = app_id || 'default';

  try {
    // Get client IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               'unknown';

    // Look up user by HWID + app_id
    const { data, error } = await supabase
      .from('licenses')
      .select('*')
      .eq('hwid', hwid)
      .eq('app_id', appId)
      .maybeSingle();

    if (error) throw error;

    // ═══ NEW USER ═══
    if (!data) {
      // Check if there's an app config for trial duration
      let trialHours = DEFAULT_TRIAL_HOURS;
      const { data: appConfig } = await supabase
        .from('app_config')
        .select('trial_hours')
        .eq('app_id', appId)
        .maybeSingle();
      if (appConfig?.trial_hours) trialHours = appConfig.trial_hours;

      const trialEnd = new Date();
      trialEnd.setHours(trialEnd.getHours() + trialHours);

      const { data: newUser, error: insertError } = await supabase
        .from('licenses')
        .insert([{
          hwid,
          app_id: appId,
          status: 'trial',
          record_type: 'user',
          trial_end: trialEnd.toISOString(),
          last_check: new Date().toISOString(),
          ip_address: ip,
          fingerprint: fingerprint || null,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();

      if (insertError) throw insertError;

      return res.status(200).json({
        status: 'trial',
        trial_end: trialEnd.toISOString(),
        hours_left: trialHours.toFixed(1),
        message: `Trial started: ${trialHours}h`,
      });
    }

    // ═══ BANNED ═══
    if (data.status === 'banned') {
      return res.status(403).json({
        error: 'Access revoked',
        status: 'banned',
      });
    }

    // ═══ KILLED ═══
    if (data.status === 'killed') {
      // Acknowledge kill — the client will self-destruct
      await supabase
        .from('licenses')
        .update({ 
          status: 'dead',
          last_check: new Date().toISOString(),
          ip_address: ip,
        })
        .eq('id', data.id);

      return res.status(200).json({
        status: 'killed',
        kill: true,
        message: 'Application terminated by administrator',
      });
    }

    // ═══ WIPED ═══
    if (data.status === 'wiped') {
      await supabase
        .from('licenses')
        .update({ 
          status: 'dead',
          last_check: new Date().toISOString(),
          ip_address: ip,
        })
        .eq('id', data.id);

      return res.status(200).json({
        status: 'wiped',
        wipe: true,
        message: 'Application wiped by administrator',
      });
    }

    // ═══ DEAD (already killed/wiped) ═══
    if (data.status === 'dead') {
      return res.status(403).json({
        status: 'dead',
        kill: true,
        error: 'Application has been terminated',
      });
    }

    // ═══ ACTIVE LICENSE ═══
    if (data.status === 'active' && data.license_key) {
      // Check for pending commands
      const pendingCmd = data.pending_command || null;
      
      await supabase
        .from('licenses')
        .update({
          last_check: new Date().toISOString(),
          ip_address: ip,
          fingerprint: fingerprint || data.fingerprint,
          pending_command: null, // clear command after delivery
        })
        .eq('id', data.id);

      const response = {
        status: 'active',
        activated_at: data.activated_at,
        license_key: data.license_key,
      };

      // Deliver pending command
      if (pendingCmd === 'kill') {
        response.kill = true;
        response.message = 'Kill command received';
      } else if (pendingCmd === 'wipe') {
        response.wipe = true;
        response.message = 'Wipe command received';
      }

      return res.status(200).json(response);
    }

    // ═══ TRIAL ═══
    if (data.status === 'trial') {
      const trialEnd = new Date(data.trial_end);
      const now = new Date();
      const hoursLeft = Math.max(0, (trialEnd - now) / (1000 * 60 * 60));

      // Check for pending commands
      const pendingCmd = data.pending_command || null;

      if (hoursLeft <= 0) {
        await supabase
          .from('licenses')
          .update({
            status: 'expired',
            last_check: new Date().toISOString(),
            ip_address: ip,
          })
          .eq('id', data.id);

        return res.status(402).json({
          error: 'Trial expired',
          status: 'expired',
        });
      }

      await supabase
        .from('licenses')
        .update({
          last_check: new Date().toISOString(),
          ip_address: ip,
          fingerprint: fingerprint || data.fingerprint,
          pending_command: null,
        })
        .eq('id', data.id);

      const response = {
        status: 'trial',
        trial_end: data.trial_end,
        hours_left: hoursLeft.toFixed(1),
      };

      if (pendingCmd === 'kill') {
        response.kill = true;
        response.message = 'Kill command received';
      } else if (pendingCmd === 'wipe') {
        response.wipe = true;
        response.message = 'Wipe command received';
      }

      return res.status(200).json(response);
    }

    // ═══ EXPIRED ═══
    if (data.status === 'expired') {
      return res.status(402).json({
        error: 'Trial expired',
        status: 'expired',
      });
    }

    return res.status(400).json({ error: 'Invalid license state', status: data.status });

  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({ error: error.message });
  }
}
