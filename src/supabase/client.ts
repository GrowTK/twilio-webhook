import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

export interface ConsciousnessRecord {
  identity: string;
  personality: string;
  rules: string;
  mission: string;
}

export interface ChannelSession {
  caller_id: string;
  created_at: string;
  summary?: string;
  transcript?: string;
  [key: string]: unknown;
}

/**
 * Fetch the most recent frendlia_consciousness record and build a system prompt.
 */
export async function getSystemPrompt(): Promise<string> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from('frendlia_consciousness')
    .select('identity, personality, rules, mission')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    console.error('[Supabase] Failed to fetch consciousness:', error?.message);
    return 'You are a helpful AI assistant.';
  }

  const record = data as ConsciousnessRecord;
  const prompt = [
    record.identity,
    record.personality,
    record.rules,
    record.mission,
  ]
    .filter(Boolean)
    .join('\n\n');

  console.log(`[Supabase] Loaded consciousness (${prompt.length} chars)`);
  return prompt;
}

/**
 * Fetch the last 5 conversation sessions for a given caller.
 */
export async function getConversationContext(callerId: string): Promise<string> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from('frendlia_channel_sessions')
    .select('*')
    .eq('caller_id', callerId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error || !data || data.length === 0) {
    console.log(`[Supabase] No prior sessions for ${callerId}`);
    return '';
  }

  console.log(`[Supabase] Found ${data.length} prior sessions for ${callerId}`);

  const context = data
    .reverse() // chronological order
    .map((session: ChannelSession, i: number) => {
      const parts = [`Session ${i + 1} (${session.created_at}):`];
      if (session.summary) parts.push(`Summary: ${session.summary}`);
      if (session.transcript) parts.push(`Transcript: ${session.transcript}`);
      return parts.join('\n');
    })
    .join('\n\n');

  return context;
}
