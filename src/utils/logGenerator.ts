import * as fs from 'fs';
import * as path from 'path';

let logTemplates: Record<string, string> | null = null;
let cardsData: { chance: any[]; communityChest: any[] } | null = null;

export function loadLogTemplates() {
  if (!logTemplates) {
    try {
      const filePath = path.join(__dirname, '../config/game_data/logs.json');
      const data = fs.readFileSync(filePath, 'utf8');
      logTemplates = JSON.parse(data);
    } catch (err) {
      console.error('Failed to load logs.json', err);
      logTemplates = {};
    }
  }
  return logTemplates;
}

export function generateLog(key: string, params: Record<string, any>): string {
  const templates = loadLogTemplates();
  let template = templates[key];

  if (!template) {
    // Fallback if key not found
    return `[${key}] ${JSON.stringify(params)}`;
  }

  // Replace all {placeholder} with actual values
  for (const [k, v] of Object.entries(params)) {
    const regex = new RegExp(`{${k}}`, 'g');
    template = template.replace(regex, String(v));
  }

  return template;
}

export function drawCard(type: 'chance' | 'communityChest') {
  if (!cardsData) {
    try {
      const filePath = path.join(__dirname, '../config/game_data/cards.json');
      const data = fs.readFileSync(filePath, 'utf8');
      cardsData = JSON.parse(data);
    } catch (err) {
      console.error('Failed to load cards.json', err);
      cardsData = { chance: [], communityChest: [] };
    }
  }

  const deck = cardsData![type];
  if (!deck || deck.length === 0) return null;

  const randomIndex = Math.floor(Math.random() * deck.length);
  return deck[randomIndex];
}
