/**
 * Admin API — /api/admin
 *
 * POST with { action, secret, ... }
 *
 * Actions:
 *   generate   — Create a new license key
 *   activate   — Manually bind HWID to key, set status = active
 *   set-trial  — Update trial_end and status for a HWID
 *   list       — List all licenses (paginated)
 *   search     — Search by HWID, license_key, or IP
 *   ban        — Ban a HWID or license key
 *   unban      — Unban a HWID or license key
 *   kill       — Set pending_command = 'kill' for a HWID
 *   wipe       — Set pending_command = 'wipe' for a HWID
 *   erase-app  — Delete a user's installed app data (wipe + ban + purge record)
 *   delete     — Permanently delete a license record
 *   stats      — Get summary statistics of all licenses
 *
 * Authentication: ADMIN_SECRET env var
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function generateLicenseKey() {
  // Format: XXXX-XXXX-XXXX-XXXX (uppercase alphanumeric)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [];
  for (let s = 0; s < 4; s++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      seg += chars[crypto.randomInt(chars.length)];
    }
    segments.push(seg);
  }
  return segments.join('-');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, secret, ...params } = req.body || {};

  // Auth check
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!action) {
    return res.status(400).json({ error: 'Action is required' });
  }

  const appId = params.app_id || 'default';

  try {
    switch (action) {

      // ═══ GENERATE — Create a new license key ═══
      case 'generate': {
        const count = Math.min(params.count || 1, 100);
        const keys = [];
        for (let i = 0; i < count; i++) {
          const key = generateLicenseKey();
          const { data, error } = await supabase
            .from('licenses')
            .insert([{
              license_key: key,
              app_id: appId,
              status: 'unused',
              record_type: 'key',
              created_at: new Date().toISOString(),
              notes: params.notes || null,
            }])
            .select()
            .single();

          if (error) throw error;
          keys.push({ key, id: data.id });
        }
        return res.status(200).json({ success: true, keys, count: keys.length });
      }

      // ═══ ACTIVATE — Manually bind HWID + set active ═══
      case 'activate': {
        if (!params.hwid || !params.license_key) {
          return res.status(400).json({ error: 'hwid and license_key required' });
        }
        const { error } = await supabase
          .from('licenses')
          .update({
            hwid: params.hwid,
            status: 'active',
            activated_at: new Date().toISOString(),
          })
          .eq('license_key', params.license_key)
          .eq('app_id', appId);

        if (error) throw error;
        return res.status(200).json({ success: true, message: 'Activated' });
      }

      // ═══ SET-TRIAL — Update trial_end, status for HWID ═══
      case 'set-trial': {
        if (!params.hwid) return res.status(400).json({ error: 'hwid required' });
        const hours = params.hours || 12;
        const trialEnd = new Date();
        trialEnd.setHours(trialEnd.getHours() + hours);

        const { error } = await supabase
          .from('licenses')
          .update({
            status: 'trial',
            trial_end: trialEnd.toISOString(),
          })
          .eq('hwid', params.hwid)
          .eq('app_id', appId)
          .eq('record_type', 'user');

        if (error) throw error;
        return res.status(200).json({ success: true, trial_end: trialEnd.toISOString(), hours });
      }

      // ═══ LIST — Paginated license list ═══
      case 'list': {
        const page = params.page || 1;
        const limit = Math.min(params.limit || 50, 200);
        const offset = (page - 1) * limit;

        let query = supabase
          .from('licenses')
          .select('*', { count: 'exact' })
          .eq('app_id', appId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (params.record_type) query = query.eq('record_type', params.record_type);
        if (params.status) query = query.eq('status', params.status);

        const { data, count, error } = await query;
        if (error) throw error;

        return res.status(200).json({
          success: true,
          data,
          total: count,
          page,
          limit,
          pages: Math.ceil((count || 0) / limit),
        });
      }

      // ═══ SEARCH — Search by HWID, key, or IP ═══
      case 'search': {
        if (!params.query) return res.status(400).json({ error: 'query required' });
        const q = params.query;

        const { data, error } = await supabase
          .from('licenses')
          .select('*')
          .eq('app_id', appId)
          .or(`hwid.ilike.%${q}%,license_key.ilike.%${q}%,ip_address.ilike.%${q}%`)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        return res.status(200).json({ success: true, data, count: data.length });
      }

      // ═══ BAN ═══
      case 'ban': {
        if (!params.hwid && !params.license_key) {
          return res.status(400).json({ error: 'hwid or license_key required' });
        }
        let query = supabase.from('licenses').update({ status: 'banned' }).eq('app_id', appId);
        if (params.hwid) query = query.eq('hwid', params.hwid);
        else query = query.eq('license_key', params.license_key);

        const { error } = await query;
        if (error) throw error;
        return res.status(200).json({ success: true, message: 'Banned' });
      }

      // ═══ UNBAN ═══
      case 'unban': {
        if (!params.hwid && !params.license_key) {
          return res.status(400).json({ error: 'hwid or license_key required' });
        }
        // Set status back to trial or active depending on key presence
        let query = supabase.from('licenses');
        const { data: record } = params.hwid
          ? await supabase.from('licenses').select('license_key').eq('hwid', params.hwid).eq('app_id', appId).maybeSingle()
          : await supabase.from('licenses').select('license_key').eq('license_key', params.license_key).eq('app_id', appId).maybeSingle();

        const newStatus = record?.license_key ? 'active' : 'trial';

        if (params.hwid) {
          await supabase.from('licenses').update({ status: newStatus }).eq('hwid', params.hwid).eq('app_id', appId);
        } else {
          await supabase.from('licenses').update({ status: newStatus }).eq('license_key', params.license_key).eq('app_id', appId);
        }

        return res.status(200).json({ success: true, message: `Unbanned (status: ${newStatus})` });
      }

      // ═══ KILL — Remote kill command ═══
      case 'kill': {
        if (!params.hwid) return res.status(400).json({ error: 'hwid required' });
        const { error } = await supabase
          .from('licenses')
          .update({ pending_command: 'kill' })
          .eq('hwid', params.hwid)
          .eq('app_id', appId);

        if (error) throw error;
        return res.status(200).json({ success: true, message: 'Kill command queued' });
      }

      // ═══ WIPE — Remote wipe command ═══
      case 'wipe': {
        if (!params.hwid) return res.status(400).json({ error: 'hwid required' });
        const { error } = await supabase
          .from('licenses')
          .update({ pending_command: 'wipe' })
          .eq('hwid', params.hwid)
          .eq('app_id', appId);

        if (error) throw error;
        return res.status(200).json({ success: true, message: 'Wipe command queued' });
      }

      // ═══ ERASE-APP — Delete a user's installed app (wipe command + ban + purge) ═══
      case 'erase-app': {
        if (!params.hwid) return res.status(400).json({ error: 'hwid required' });

        // 1. Set pending_command = 'wipe' so the app self-destructs on next check
        await supabase
          .from('licenses')
          .update({ pending_command: 'wipe', status: 'banned' })
          .eq('hwid', params.hwid)
          .eq('app_id', appId);

        // 2. If purge flag is set, also delete the record entirely
        if (params.purge) {
          await supabase
            .from('licenses')
            .delete()
            .eq('hwid', params.hwid)
            .eq('app_id', appId);

          return res.status(200).json({
            success: true,
            message: `User app erased and record purged for HWID ${params.hwid.substring(0, 16)}`,
            purged: true,
          });
        }

        return res.status(200).json({
          success: true,
          message: `Erase-app command sent for HWID ${params.hwid.substring(0, 16)} (wipe + ban)`,
          purged: false,
        });
      }

      // ═══ DELETE — Permanently delete a license/user record ═══
      case 'delete': {
        if (!params.id && !params.hwid && !params.license_key) {
          return res.status(400).json({ error: 'id, hwid, or license_key required' });
        }

        let query = supabase.from('licenses').delete().eq('app_id', appId);
        if (params.id) query = query.eq('id', params.id);
        else if (params.hwid) query = query.eq('hwid', params.hwid);
        else query = query.eq('license_key', params.license_key);

        const { error } = await query;
        if (error) throw error;
        return res.status(200).json({ success: true, message: 'Record deleted' });
      }

      // ═══ STATS — Summary statistics ═══
      case 'stats': {
        const { data: allRecords, error } = await supabase
          .from('licenses')
          .select('status, record_type')
          .eq('app_id', appId);

        if (error) throw error;

        const stats = {
          total: allRecords.length,
          active: allRecords.filter(r => r.status === 'active').length,
          trial: allRecords.filter(r => r.status === 'trial').length,
          expired: allRecords.filter(r => r.status === 'expired').length,
          banned: allRecords.filter(r => r.status === 'banned').length,
          dead: allRecords.filter(r => r.status === 'dead').length,
          unused_keys: allRecords.filter(r => r.status === 'unused' && r.record_type === 'key').length,
          users: allRecords.filter(r => r.record_type === 'user').length,
          keys: allRecords.filter(r => r.record_type === 'key').length,
        };

        return res.status(200).json({ success: true, stats });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

  } catch (error) {
    console.error('Admin API error:', error);
    return res.status(500).json({ error: error.message });
  }
}
