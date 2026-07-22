import { sql } from './src/lib/db.js';
import dotenv from 'dotenv';
dotenv.config();

async function migrate() {
  console.log('Running migration: resetting rating to 0 for players with 0 games...');
  try {
    // Ensure rating defaults to 0 and games_played defaults to 0
    await sql`
      ALTER TABLE players 
      ALTER COLUMN rating SET DEFAULT 0,
      ALTER COLUMN games_played SET DEFAULT 0;
    `;
    
    // Reset existing players with 0 games to 0 rating
    await sql`
      UPDATE players 
      SET rating = 0 
      WHERE games_played = 0;
    `;
    
    console.log('Migration successful!');
  } catch (error) {
    console.error('Migration failed:', error);
  }
}

migrate();
