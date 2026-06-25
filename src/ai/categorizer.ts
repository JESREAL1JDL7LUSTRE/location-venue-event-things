import Anthropic from '@anthropic-ai/sdk';
import { inArray, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventsEvent } from '../../drizzle/schema.js';

const CANONICAL_CATEGORIES = [
  'Fun Run',
  'Trail Run',
  'Triathlon',
  'Cycling',
  'Swimming',
  'Sports & Fitness',
  'Music & Concert',
  'Festival',
  'Conference',
  'Workshop',
  'Food & Dining',
  'Arts & Culture',
  'Theater',
  'Charity',
  'Other',
] as const;

type Category = (typeof CANONICAL_CATEGORIES)[number];

const validateLabels = (raw: unknown[]): Category[] => {
  const valid = raw.filter((l): l is Category =>
    typeof l === 'string' && (CANONICAL_CATEGORIES as readonly string[]).includes(l),
  );
  return valid.length ? valid : ['Other'];
};

const buildPrompt = (events: Array<{ id: number; name: string; category: string; description: string }>) => {
  const list = events.map((e) => ({
    id: e.id,
    name: e.name,
    raw_category: e.category,
    description: e.description.substring(0, 300),
  }));

  return `You are an event categorization assistant. Classify each event into 1-2 categories from this list:
${CANONICAL_CATEGORIES.join(', ')}

Events to classify (JSON array):
${JSON.stringify(list, null, 2)}

Respond with a JSON object mapping event id (as string) to an array of category labels.
Example: {"123": ["Music & Concerts"], "456": ["Sports & Fitness", "Health & Wellness"]}
Only use categories from the provided list. Do not include any other text.`;
};

export const categorizeEventsByIds = async (eventIds: number[]): Promise<void> => {
  if (!eventIds.length) return;

  const client = new Anthropic();
  const events = await db
    .select({ id: eventsEvent.id, name: eventsEvent.name, category: eventsEvent.category, description: eventsEvent.description })
    .from(eventsEvent)
    .where(inArray(eventsEvent.id, eventIds));

  if (!events.length) return;

  const prompt = buildPrompt(events);
  let raw: Record<string, unknown[]> = {};

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) raw = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn('Auto-categorization failed:', err);
    return;
  }

  for (const [idStr, labels] of Object.entries(raw)) {
    const id = parseInt(idStr, 10);
    if (isNaN(id) || !Array.isArray(labels)) continue;
    const categories = validateLabels(labels);
    await db
      .update(eventsEvent)
      .set({ agentCategories: categories })
      .where(eq(eventsEvent.id, id))
      .catch(() => {});
  }
};
