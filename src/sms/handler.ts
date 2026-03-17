import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { getSystemPrompt, getConversationContext } from '../supabase/client';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Handle an incoming SMS: fetch consciousness + context, ask Claude, reply via SMS.
 */
export async function handleIncomingSms(
  from: string,
  to: string,
  body: string
): Promise<void> {
  console.log(`[SMS] Incoming from ${from}: "${body}"`);

  // Fetch system prompt from Supabase
  let systemPrompt = '';
  try {
    systemPrompt = await getSystemPrompt();
  } catch (err: any) {
    console.error('[SMS] Failed to fetch system prompt:', err?.message);
    systemPrompt = 'You are a helpful AI assistant.';
  }

  // Fetch conversation context
  let conversationContext = '';
  try {
    conversationContext = await getConversationContext(from);
  } catch (err: any) {
    console.error('[SMS] Failed to fetch conversation context:', err?.message);
  }

  // Build messages for Claude
  const messages: Anthropic.MessageParam[] = [];

  if (conversationContext) {
    messages.push({
      role: 'user',
      content: `Previous conversation context:\n${conversationContext}`,
    });
    messages.push({
      role: 'assistant',
      content: 'I understand the context from our previous conversations. How can I help you?',
    });
  }

  messages.push({
    role: 'user',
    content: body,
  });

  // Call Claude
  let reply = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300, // SMS is short
      system: systemPrompt,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    reply = textBlock?.text ?? 'Sorry, I could not generate a response.';
  } catch (err: any) {
    console.error('[SMS] Claude API error:', err?.message);
    reply = 'Sorry, I am having trouble right now. Please try again later.';
  }

  // Trim reply to SMS limits (1600 chars for Twilio)
  if (reply.length > 1600) {
    reply = reply.slice(0, 1597) + '...';
  }

  console.log(`[SMS] Replying to ${from}: "${reply.slice(0, 100)}..."`);

  // Send reply via Twilio
  try {
    await twilioClient.messages.create({
      body: reply,
      from: to,
      to: from,
    });
    console.log(`[SMS] Reply sent to ${from}`);
  } catch (err: any) {
    console.error('[SMS] Failed to send reply:', err?.message);
  }
}
