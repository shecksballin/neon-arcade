import { sql } from './src/lib/db.js';

async function setup() {
  console.log('Setting up database tables...');
  try {
    // Create players table
    await sql`
      CREATE TABLE IF NOT EXISTS players (
        name TEXT PRIMARY KEY,
        avatar_url TEXT,
        rating INTEGER DEFAULT 1200,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Create match_history table
    await sql`
      CREATE TABLE IF NOT EXISTS match_history (
        id SERIAL PRIMARY KEY,
        game_type TEXT NOT NULL, 
        player1_name TEXT NOT NULL,
        player2_name TEXT NOT NULL,
        winner_name TEXT,
        score_p1 INTEGER,
        score_p2 INTEGER,
        p1_rating_before INTEGER,
        p1_rating_after INTEGER,
        p2_rating_before INTEGER,
        p2_rating_after INTEGER,
        played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    console.log('Database setup complete!');
  } catch (error) {
    console.error('Error setting up database:', error);
  }
}

setup();
