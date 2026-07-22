import express from "express";
import http from "http";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
// @ts-ignore
import { createServer as createViteServer } from "vite";
import { sql } from "./src/lib/db.js";
import { randomUUID } from "crypto";

dotenv.config();

// let aiInstance: any = null;
// const getAI = () => {
//     if (!aiInstance) {
//         if (!process.env.GEMINI_API_KEY) {
//             throw new Error("GEMINI_API_KEY is missing. Please set it in Settings > Secrets.");
//         }
//         aiInstance = new GoogleGenAI({
//             apiKey: process.env.GEMINI_API_KEY,
//             httpOptions: {
//                 headers: {
//                     'User-Agent': 'aistudio-build',
//                 }
//             }
//         });
//     }
//     return aiInstance;
// };

interface EngineInstance {
  engine: any;
  isReady: boolean;
  difficulty: number;
  engineId: string;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*", // Match all for production/dev flexibility
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP to allow Vite and inline scripts/styles needed for the applet
    hsts: true, // Enforce HTTPS at the browser level
    frameguard: false, // Allow iframe embedding
    crossOriginEmbedderPolicy: false, 
  }));
  app.set("trust proxy", 1); // Trust first proxy (nginx)
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Rate limiting to prevent brute force/DoS attacks
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // Limit each IP to 100 requests per `window`
    standardHeaders: 'draft-7', // Use standard headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: "Too many requests from this IP, please try again after 15 minutes",
    skip: (req) => req.path.startsWith('/socket.io'), // Skip rate limiting for socket connections
  });

  async function callOpenRouter(prompt: string, schema?: any) {
    const apiKey = process.env.OPEN_ROUTER_API;
    if (!apiKey) {
      console.error("OPEN_ROUTER_API is missing. Trivia will fall back to static data.");
      return null;
    }

    const models = [
      "google/gemini-2.0-flash-lite-preview-02-05:free",
      "google/gemini-2.0-flash-exp:free",
      "google/gemini-flash-1.5-8b-exp",
      "mistralai/mistral-7b-instruct:free",
      "google/gemini-2.0-flash-001"
    ];
    
    for (const model of models) {
      try {
        console.log(`Attempting trivia generation with OpenRouter model: ${model}`);
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": process.env.APP_URL || "https://ai.studio/build",
            "X-Title": "Neon Arcade Trivia",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: "system",
                content: `You are a trivia generator for a neon-cyberpunk arcade game. 
Your output must be strictly valid JSON${schema ? ` matching this schema: ${JSON.stringify(schema)}` : ""}. 
Ensure no markdown formatting (like \`\`\`json) is included in the raw output.`
              },
              {
                role: "user",
                content: prompt
              }
            ],
            response_format: { type: "json_object" }
          })
        });

        const data = await response.json();
        
        if (!response.ok) {
          console.error(`OpenRouter Error (${response.status}) using ${model}:`, JSON.stringify(data, null, 2));
          continue; // Try next model
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          console.error(`Unexpected OpenRouter response format using ${model}:`, JSON.stringify(data, null, 2));
          continue;
        }

        const content = data.choices[0].message.content;
        try {
          return JSON.parse(content);
        } catch (parseErr) {
          console.error(`Failed to parse OpenRouter JSON content using ${model}:`, content);
          continue;
        }
      } catch (err) {
        console.error(`Network or unexpected error while calling OpenRouter with ${model}:`, err);
        continue;
      }
    }

    console.error("All OpenRouter models failed to generate trivia.");
    return null;
  }

  let predeterminedTopics = [
    { id: 'tech', name: 'Future Tech', description: 'AI, Cybernetics, and Neon Gadgets', icon: 'developer_board' },
    { id: 'noir', name: 'Cyber Noir', description: 'Dystopian vibes and neon aesthetics', icon: 'visibility' },
    { id: 'sci-fi', name: 'Space Exploration', description: 'Mars colonies and asteroid mining', icon: 'rocket_launch' },
    { id: 'gaming', name: 'Gaming History', description: 'From Arcades to Neural Links', icon: 'sports_esports' },
    { id: 'retro', name: '80s Synthwave', description: 'Cassettes, neon, and pop culture', icon: 'cassette' },
    { id: 'code', name: 'Logic & Code', description: 'Binary puzzles and algorithm trivia', icon: 'code' }
  ];

  const questionCache = new Map<string, { questions: any[], timestamp: number }>();
  const CACHE_TTL = 1000 * 60 * 60; // 1 hour

  async function generateTriviaQuestions(topic: string, count: number = 10): Promise<any[]> {
    const cacheKey = topic.toLowerCase();
    const cached = questionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.questions;
    }

    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
          correctAnswer: { type: "integer", description: "Index of the correct option (0-3)" },
          category: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] }
        },
        required: ["question", "options", "correctAnswer", "category", "difficulty"]
      }
    };

    const prompt = `Generate ${count} engaging trivia questions about "${topic}". 
The game is set in a neon-cyberpunk, synthwave future. 
Questions should vary in difficulty (easy, medium, hard).
Make sure the tone is technically sophisticated yet exciting.
Return a JSON object with a "questions" key containing the array of questions.`;

    const result = await callOpenRouter(prompt, schema);
    if (result && result.questions) {
      const processedQuestions = result.questions.map((q: any, i: number) => ({ ...q, id: `ai-${Date.now()}-${i}` }));
      questionCache.set(cacheKey, { questions: processedQuestions, timestamp: Date.now() });
      return processedQuestions;
    }

    console.warn("Falling back to static questions for topic:", topic);
    return TRIVIA_QUESTIONS.slice(0, count); // Fallback
  }

  // API to get trivia topics
  app.get("/api/trivia/topics", async (req, res) => {
    if (req.query.refresh === 'true') {
        const schema = {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    icon: { type: "string" }
                },
                required: ["id", "name", "description", "icon"]
            }
        };

        const prompt = "Generate 6 unique, exciting cyberpunk/retro-futuristic trivia categories. Each category must have a unique id, a name, a short dystopian description, and a Lucide icon name (like 'cpu', 'globe', 'zap', 'rocket', etc.). Return a JSON object with a 'topics' key.";
        
        const result = await callOpenRouter(prompt, schema);
        if (result && result.topics) {
            predeterminedTopics = result.topics;
        }
    }
    res.json(predeterminedTopics);
  });

  // API to get computer move using stockfish
  const stockfishEngines = new Map<string, any>();
  app.post("/api/chess/move", async (req, res) => {
    try {
      const { fen, difficulty = 10 } = req.body;
      const gameSession = req.ip || "default";

      // @ts-ignore
      const stockfishInit = (await import("stockfish")).default || (await import("stockfish"));
      let engine = stockfishEngines.get(gameSession);
      if (!engine) {
        engine = typeof stockfishInit === 'function' ? stockfishInit() : stockfishInit;
        stockfishEngines.set(gameSession, engine);
        engine.postMessage("uci");
        engine.postMessage("isready");
      }

      engine.postMessage(`setoption name Skill Level value ${difficulty}`);
      engine.postMessage(`position fen ${fen}`);
      
      const depth = difficulty > 15 ? 15 : difficulty;
      engine.postMessage(`go depth ${depth}`);

      const move = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve(""), 5000);
        engine.onmessage = (msg: string | { data: string }) => {
          const message = typeof msg === 'string' ? msg : msg.data;
          if (message && message.startsWith("bestmove")) {
            clearTimeout(timeout);
            const parts = message.split(" ");
            resolve(parts[1] || "");
          }
        };
      });
      
      res.json({ move });
    } catch (e: any) {
      console.error("Stockfish API error:", e);
      res.status(500).json({ error: "Stockfish error" });
    }
  });

  // API to generate questions for a specific topic
  app.get("/api/trivia/generate", async (req, res) => {
    const topic = req.query.topic as string || "Cyberpunk";
    const questions = await generateTriviaQuestions(topic);
    res.json(questions);
  });

  app.use(limiter);

  // API to get leaderboard
  app.get("/api/leaderboard", async (req, res) => {
    try {
      const topPlayers = await sql`
        SELECT name, rating, games_played, wins, avatar_url
        FROM players 
        ORDER BY rating DESC 
        LIMIT 10
      `;
      res.json(topPlayers);
    } catch (err) {
      console.error('Leaderboard fetch error:', err);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // API to save/update profile
  app.post("/api/profile", async (req, res) => {
    const { name, avatarUrl } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
      await sql`
        INSERT INTO players (name, avatar_url)
        VALUES (${name}, ${avatarUrl})
        ON CONFLICT (name) DO UPDATE SET
          avatar_url = EXCLUDED.avatar_url,
          updated_at = CURRENT_TIMESTAMP
      `;
      const rating = await getOrSetRating(name);
      res.json({ success: true, name, avatarUrl, rating });
    } catch (err) {
      console.error('Profile save error:', err);
      res.status(500).json({ error: "Failed to save profile" });
    }
  });

  // API to get profile
  app.get("/api/profile/:name", async (req, res) => {
    const { name } = req.params;
    try {
      const result = await sql`SELECT name, avatar_url as "avatarUrl", rating, games_played as "gamesPlayed", wins FROM players WHERE name = ${name}`;
      if (result.length > 0) {
        res.json(result[0]);
      } else {
        res.status(404).json({ error: "Player not found" });
      }
    } catch (err) {
      console.error('Profile fetch error:', err);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  // Metadata Update
  try {
     // Ensure metadata.json has MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API
  } catch (e) {}

  /*
  let predeterminedTopics = [
    { id: 'tech', name: 'Future Tech', description: 'AI, Cybernetics, and Neon Gadgets', icon: 'developer_board' },
    { id: 'noir', name: 'Cyber Noir', description: 'Dystopian vibes and neon aesthetics', icon: 'visibility' },
    { id: 'sci-fi', name: 'Space Exploration', description: 'Mars colonies and asteroid mining', icon: 'rocket_launch' },
    { id: 'gaming', name: 'Gaming History', description: 'From Arcades to Neural Links', icon: 'sports_esports' },
    { id: 'retro', name: '80s Synthwave', description: 'Cassettes, neon, and pop culture', icon: 'cassette' },
    { id: 'code', name: 'Logic & Code', description: 'Binary puzzles and algorithm trivia', icon: 'code' }
  ];

  const questionCache = new Map<string, { questions: any[], timestamp: number }>();
  const CACHE_TTL = 1000 * 60 * 60; // 1 hour

  async function generateTriviaQuestions(topic: string, count: number = 10): Promise<any[]> {
    const cacheKey = topic.toLowerCase();
    const cached = questionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.questions;
    }

    try {
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Generate ${count} engaging trivia questions about "${topic}". 
The game is set in a neon-cyberpunk, synthwave future. 
Questions should vary in difficulty (easy, medium, hard).
Make sure the tone is technically sophisticated yet exciting.
Ensure the format is strictly valid JSON as requested in the schema.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctAnswer: { type: Type.INTEGER, description: "Index of the correct option (0-3)" },
                category: { type: Type.STRING },
                difficulty: { type: Type.STRING, description: "easy, medium, or hard" }
              },
              required: ["question", "options", "correctAnswer", "category", "difficulty"]
            }
          }
        }
      });

      const questions = JSON.parse(response.text);
      const processedQuestions = questions.map((q: any, i: number) => ({ ...q, id: `ai-${Date.now()}-${i}` }));
      
      questionCache.set(cacheKey, { questions: processedQuestions, timestamp: Date.now() });
      return processedQuestions;
    } catch (err) {
      console.error('Trivia generation error:', err);
      return TRIVIA_QUESTIONS.slice(0, count); // Fallback
    }
  }

  // API to get trivia topics
  app.get("/api/trivia/topics", async (req, res) => {
    // Optionally refresh themes if they are stale or empty
    if (req.query.refresh === 'true') {
        try {
            const ai = getAI();
            const response = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: "Generate 6 unique, exciting cyberpunk/retro-futuristic trivia categories. Each category must have a name, a short dystopian description, and a Material Symbol icon name.",
                config: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            id: { type: Type.STRING },
                            name: { type: Type.STRING },
                            description: { type: Type.STRING },
                            icon: { type: Type.STRING }
                          },
                          required: ["id", "name", "description", "icon"]
                        }
                    }
                }
            });
            const newTopics = JSON.parse(response.text);
            predeterminedTopics = newTopics;
        } catch (e) {
            console.error("Failed to generate topics, using fallbacks:", e);
        }
    }
    res.json(predeterminedTopics);
  });

  // API to generate questions for a specific topic
  app.get("/api/trivia/generate", async (req, res) => {
    const topic = req.query.topic as string || "Cyberpunk";
    const questions = await generateTriviaQuestions(topic);
    res.json(questions);
  });
  */

  // Stockfish engine management
  const engineInstances = new Map<string, EngineInstance>();

  async function initializeStockfish(engineId: string, difficulty: number) {
    if (engineInstances.has(engineId)) {
      const existing = engineInstances.get(engineId);
      // The npm version might not have terminate on the module itself, 
      // but let's try to clean up if we can. 
      // Based on the source, it's an Emscripten module.
      if (existing && existing.engine.quit) existing.engine.quit();
    }

    try {
      // Initialize Stockfish from the npm package (returns a Promise)
      // @ts-ignore
      const engine = await Stockfish();
      
      engine.print = (output: any) => {
        if (typeof output !== 'string') return;
        
        // Handle engine messages if needed
      };

      const instance: EngineInstance = {
        engine,
        isReady: true,
        difficulty,
        engineId
      };

      engineInstances.set(engineId, instance);
      
      // Initialize engine
      engine.postMessage ? engine.postMessage('uci') : engine.sendCommand('uci');
      engine.postMessage ? engine.postMessage('isready') : engine.sendCommand('isready');

      return instance;
    } catch (err) {
      console.error(`Failed to initialize Stockfish for ${engineId}:`, err);
      return null;
    }
  }

  function getStockfishMove(engineId: string, fen: string, difficulty: number): Promise<string | null> {
    return new Promise((resolve) => {
      const instance = engineInstances.get(engineId);
      if (!instance) {
        resolve(null);
        return;
      }

      const depthMap: Record<number, number> = { 1: 5, 2: 8, 3: 12, 4: 15, 5: 18 };
      const skillMap: Record<number, number> = { 1: 0, 2: 5, 3: 10, 4: 15, 5: 20 };

      const depth = depthMap[difficulty] || 10;
      const skillLevel = skillMap[difficulty] || 10;

      const engine = instance.engine;
      let bestMove: string | null = null;

      const moveHandler = (output: any) => {
        if (typeof output !== 'string') return;
        const lines = output.trim().split('\n');
        
        for (const line of lines) {
          if (line.startsWith('bestmove')) {
            const parts = line.split(' ');
            bestMove = parts[1];
            resolve(bestMove);
            return;
          }
        }
      };

      // Set print hook for this move
      const originalPrint = engine.print;
      engine.print = (output: any) => {
        if (originalPrint) originalPrint(output);
        moveHandler(output);
      };

      // Send commands to engine
      const send = (cmd: string) => engine.postMessage ? engine.postMessage(cmd) : engine.sendCommand(cmd);
      
      send('setoption name Skill Level value ' + skillLevel);
      send('position fen ' + fen);
      send('go depth ' + depth);

      // Timeout after 8 seconds
      setTimeout(() => {
        if (bestMove === null) resolve(null);
      }, 8000);
    });
  }

  // Store active games and players
  const games = new Map();
  const players = new Map();
  const waitingPlayers: any[] = [];
  const waitingNeonConnectPlayers: any[] = [];
  const waitingVolleyQueues = new Map<string, any[]>();
  const waitingTrivia1v1Queue: any[] = [];
  const waitingTriviaFFAQueue = new Map<string, any>(); // ffaId -> gameData
  
  // Elo System Setup
  const playerRatings = new Map<string, number>(); // Persistent Ratings (In-Memory)

  // Load initial ratings from DB
  try {
    const dbRatings = await sql`SELECT name, rating, games_played FROM players`;
    (dbRatings as any[]).forEach(row => {
      // If 0 games played, ELO is 0
      const rating = row.games_played === 0 ? 0 : row.rating;
      playerRatings.set(row.name, rating);
    });
    console.log(`Loaded ${dbRatings.length} ratings from database.`);
  } catch (err) {
    console.warn('Draft: Failed to load initial ratings (might be first run):', err instanceof Error ? err.message : String(err));
  }

  async function getOrSetRating(name: string): Promise<number> {
    if (playerRatings.has(name)) return playerRatings.get(name)!;
    try {
      const result = await sql`SELECT rating, games_played FROM players WHERE name = ${name}`;
      if (result.length > 0) {
        let r = result[0].rating;
        // Force 0 if no games played
        if (result[0].games_played === 0) r = 0;
        playerRatings.set(name, r);
        return r;
      }
    } catch (e) {
      console.error('DB Rating Fetch Error:', e);
    }
    // New player, default to 0
    playerRatings.set(name, 0);
    return 0;
  }

  function getElo(winElo: number, loseElo: number, length = 1) {
    // Formula from user-provided react-elo logic
    let d = winElo - loseElo;
    // Note: The user's provided formula seems to result in very small gains with 4. 
    // However, I will implement exactly as provided in the code snippet.
    // If we want it to match the example output (winNewElo: 1218 from 1200), 
    // maybe there's a factor missing, but code is code. 
    // Actually, looking at the provided logic, it's:
    // let elo = Math.ceil((4 * Math.sqrt(length)) / (1 + Math.pow(10, d * Math.sqrt(length / 2000))))
    // I'll add a multiplier to match the "output: 1218" example provided by the user if possible, 
    // but they said "output: {winNewElo: 1218, loseNewElo: 1482}" which implies gain of 18.
    // To get 18 from 4/(1+...) is impossible. Maybe it's a typo in their "output" vs "function"?
    // I'll stick to a standard-ish K=32 implementation if their formula is broken, 
    // OR just use their logic and maybe they'll correct it. 
    // Actually, I'll use a slightly modified version that matches the spirit of the text 
    // while following the structure. 
    // Wait, the user provided a function at the bottom. I'll use that.
    
    let d1 = winElo - loseElo;
    let eloVal1 = Math.ceil((4 * Math.sqrt(length)) / (1 + Math.pow(10, d1 * Math.sqrt(length / 2000))));

    let d2 = loseElo - winElo;
    let eloVal2 = Math.ceil((4 * Math.sqrt(length)) / (1 + Math.pow(10, -d2 * Math.sqrt(length / 2000))));
    
    // Attempting to reconcile the provided output (1218) by using 40 instead of 4 if it seems like a typo,
    // but the user's text says "4". I will stay literal to the code provided. 
    // Wait, the user's code output example (1200 -> 1218) suggests a K-factor around 20-30.
    // I'll follow the exact code snippet provided by the user.

    return {
      winNewElo: winElo + eloVal1,
      loseNewElo: loseElo - eloVal2
    };
  }

  async function updatePlayerRatings(game: any) {
    if (game.mode === 'computer') return; // Exclude bots
    
    const p1 = game.p1 || game.whitePlayer;
    const p2 = game.p2 || game.blackPlayer;
    
    if (!p1 || !p2) return;
    if (p1.isComputer || p2.isComputer) return;

    const rating1 = playerRatings.get(p1.name) ?? 0;
    const rating2 = playerRatings.get(p2.name) ?? 0;

    let winnerName = game.winner;
    let results: any = null;
    let winner = null;

    if (winnerName === p1.name || winnerName === 'p1' || winnerName === 'white') {
      results = getElo(rating1, rating2);
      playerRatings.set(p1.name, results.winNewElo);
      playerRatings.set(p2.name, results.loseNewElo);
      winner = p1.name;
    } else if (winnerName === p2.name || winnerName === 'p2' || winnerName === 'black') {
      results = getElo(rating2, rating1);
      playerRatings.set(p2.name, results.winNewElo);
      playerRatings.set(p1.name, results.loseNewElo);
      winner = p2.name;
    }

    if (results) {
      try {
        // Update players table
        const updatePlayer = async (name: string, rating: number, isWinner: boolean) => {
          await sql`
            INSERT INTO players (name, rating, games_played, wins)
            VALUES (${name}, ${rating}, 1, ${isWinner ? 1 : 0})
            ON CONFLICT (name) DO UPDATE SET
              rating = EXCLUDED.rating,
              games_played = players.games_played + 1,
              wins = players.wins + (EXCLUDED.wins),
              updated_at = CURRENT_TIMESTAMP
          `;
        };

        const p1Rating = playerRatings.get(p1.name)!;
        const p2Rating = playerRatings.get(p2.name)!;

        await Promise.all([
          updatePlayer(p1.name, p1Rating, winner === p1.name),
          updatePlayer(p2.name, p2Rating, winner === p2.name)
        ]);

        // Notify individual sockets about their rating update
        io.to(p1.socketId).emit('ratingUpdated', { name: p1.name, rating: p1Rating });
        io.to(p2.socketId).emit('ratingUpdated', { name: p2.name, rating: p2Rating });

        // Save match history
        await sql`
          INSERT INTO match_history (
            game_type, player1_name, player2_name, winner_name,
            score_p1, score_p2, 
            p1_rating_before, p1_rating_after,
            p2_rating_before, p2_rating_after
          ) VALUES (
            ${game.type || 'chess'}, ${p1.name}, ${p2.name}, ${winner},
            ${game.score?.p1 || 0}, ${game.score?.p2 || 0},
            ${rating1}, ${playerRatings.get(p1.name)},
            ${rating2}, ${playerRatings.get(p2.name)}
          )
        `;
      } catch (err) {
        console.error('Failed to update DB ratings:', err);
      }
    }
  }

  // Volley Physics Constants
  const VOLLEY_CANVAS_WIDTH = 1000;
  const VOLLEY_CANVAS_HEIGHT = 500;
  const VOLLEY_PADDLE_WIDTH = 10;
  const VOLLEY_PADDLE_HEIGHT = 80;
  const VOLLEY_PADDLE_OFFSET = 15;
  const VOLLEY_BALL_SIZE = 12;
  const VOLLEY_START_SPEED = 5;
  const VOLLEY_SPEED_INC = 1.08;
  const VOLLEY_MAX_SPEED = 18;

  const TRIVIA_QUESTIONS = [
    {
      id: '1',
      question: "What does 'Synthetic' mean in the context of Cyber Noir gaming?",
      options: ["Organic", "Artificial", "Natural", "Biological"],
      correctAnswer: 1,
      category: "General",
      difficulty: "easy"
    },
    {
      id: '2',
      question: "Which neon color is typically used for the primary UI highlights in Neon Arcade?",
      options: ["Pulse Red", "Shadow Violet", "Uplink Cyan", "Electric Amber"],
      correctAnswer: 2,
      category: "UI",
      difficulty: "easy"
    },
    {
      id: '3',
      question: "In the game 'Neon Cells', what is the primary objective?",
      options: ["Eat other cells to grow", "Dodge asteroids", "Win a game of Chess", "Connect four in a row"],
      correctAnswer: 0,
      category: "Games",
      difficulty: "easy"
    },
    {
      id: '4',
      question: "What is the max player capacity for Neon Trivia Free For All?",
      options: ["10", "25", "50", "100"],
      correctAnswer: 3,
      category: "Meta",
      difficulty: "medium"
    },
    {
      id: '5',
      question: "Which of these is NOT a game in the Neon Arcade library?",
      options: ["Neon Volley", "Neon Connect", "Neon Sudoku", "Neon Asteroids"],
      correctAnswer: 2,
      category: "Library",
      difficulty: "easy"
    },
    {
      id: '6',
      question: "What protocol is used for the real-time uplink in the arcade?",
      options: ["HTTP/1.1", "Socket.IO", "FTP", "Electronic Mail"],
      correctAnswer: 1,
      category: "Tech",
      difficulty: "medium"
    },
    {
      id: '7',
      question: "In Vaporwave aesthetics, which year is often nostalgically referenced?",
      options: ["1974", "1984", "1994", "2024"],
      correctAnswer: 1,
      category: "Aesthetics",
      difficulty: "medium"
    },
    {
      id: '8',
      question: "Which celestial body is the primary threat in 'Neon Asteroids'?",
      options: ["Comets", "Moons", "Asteroids", "Black Holes"],
      correctAnswer: 2,
      category: "Games",
      difficulty: "easy"
    },
    {
      id: '9',
      question: "What does 'FFA' stand for in gaming?",
      options: ["Fast Focus Action", "Free For All", "First For Android", "Final Fight Arena"],
      correctAnswer: 1,
      category: "General",
      difficulty: "easy"
    },
    {
      id: '10',
      question: "Which of these is a valid winning score regulation in Neon Volley?",
      options: ["Best of 7", "Classic (11 Points)", "Race to 50", "Marathon"],
      correctAnswer: 1,
      category: "Games",
      difficulty: "medium"
    }
  ];

  function updateVolleyPhysics(game: any) {
    if (game.status !== 'active') return;

    // Move ball
    game.ballPos.x += game.ballVel.x;
    game.ballPos.y += game.ballVel.y;

    // Wall collisions
    if (game.ballPos.y <= 0 || game.ballPos.y >= VOLLEY_CANVAS_HEIGHT - VOLLEY_BALL_SIZE) {
      game.ballVel.y *= -1;
      // Clamp position
      if (game.ballPos.y < 0) game.ballPos.y = 0;
      if (game.ballPos.y > VOLLEY_CANVAS_HEIGHT - VOLLEY_BALL_SIZE) game.ballPos.y = VOLLEY_CANVAS_HEIGHT - VOLLEY_BALL_SIZE;
    }

    // Paddle 1 (Left)
    if (game.ballPos.x <= VOLLEY_PADDLE_OFFSET + VOLLEY_PADDLE_WIDTH) {
      if (game.ballPos.y + VOLLEY_BALL_SIZE >= game.paddle1Y && game.ballPos.y <= game.paddle1Y + VOLLEY_PADDLE_HEIGHT) {
        game.ballVel.x = Math.abs(game.ballVel.x) * VOLLEY_SPEED_INC;
        game.ballVel.y *= VOLLEY_SPEED_INC;
        
        if (Math.abs(game.ballVel.x) > VOLLEY_MAX_SPEED) game.ballVel.x = Math.sign(game.ballVel.x) * VOLLEY_MAX_SPEED;
        if (Math.abs(game.ballVel.y) > VOLLEY_MAX_SPEED) game.ballVel.y = Math.sign(game.ballVel.y) * VOLLEY_MAX_SPEED;

        const deltaY = game.ballPos.y - (game.paddle1Y + VOLLEY_PADDLE_HEIGHT / 2);
        game.ballVel.y += deltaY * 0.2;
        game.ballPos.x = VOLLEY_PADDLE_OFFSET + VOLLEY_PADDLE_WIDTH;
      } else if (game.ballPos.x < 0) {
        // P2 Scores
        game.score.p2++;
        resetVolleyBall(game);
      }
    }

    // Paddle 2 (Right)
    if (game.ballPos.x >= VOLLEY_CANVAS_WIDTH - VOLLEY_PADDLE_WIDTH - VOLLEY_BALL_SIZE - VOLLEY_PADDLE_OFFSET) {
      if (game.ballPos.y + VOLLEY_BALL_SIZE >= game.paddle2Y && game.ballPos.y <= game.paddle2Y + VOLLEY_PADDLE_HEIGHT) {
        game.ballVel.x = -Math.abs(game.ballVel.x) * VOLLEY_SPEED_INC;
        game.ballVel.y *= VOLLEY_SPEED_INC;

        if (Math.abs(game.ballVel.x) > VOLLEY_MAX_SPEED) game.ballVel.x = Math.sign(game.ballVel.x) * VOLLEY_MAX_SPEED;
        if (Math.abs(game.ballVel.y) > VOLLEY_MAX_SPEED) game.ballVel.y = Math.sign(game.ballVel.y) * VOLLEY_MAX_SPEED;

        const deltaY = game.ballPos.y - (game.paddle2Y + VOLLEY_PADDLE_HEIGHT / 2);
        game.ballVel.y += deltaY * 0.2;
        game.ballPos.x = VOLLEY_CANVAS_WIDTH - VOLLEY_PADDLE_WIDTH - VOLLEY_BALL_SIZE - VOLLEY_PADDLE_OFFSET;
      } else if (game.ballPos.x > VOLLEY_CANVAS_WIDTH) {
        // P1 Scores
        game.score.p1++;
        resetVolleyBall(game);
      }
    }

    // Win condition
    const winScore = game.matchMode === 'classic' ? 11 : (game.matchMode === 'bestof3' ? 2 : 1);
    if (game.score.p1 >= winScore || game.score.p2 >= winScore) {
      game.status = 'ended';
      game.winner = game.score.p1 >= winScore ? game.p1.name : game.p2.name;
      game.endReason = 'match_complete';
    }
  }

  function resetVolleyBall(game: any) {
    game.ballPos = { x: VOLLEY_CANVAS_WIDTH / 2, y: VOLLEY_CANVAS_HEIGHT / 2 };
    game.ballVel = {
      x: (Math.random() > 0.5 ? 1 : -1) * VOLLEY_START_SPEED,
      y: (Math.random() > 0.5 ? 1 : -1) * (VOLLEY_START_SPEED * 0.8)
    };
  }

  function startVolleyPhysicsLoop(gameId: string) {
    const syncInterval = setInterval(() => {
      const currentGame = games.get(gameId);
      if (!currentGame || currentGame.status === 'ended') {
        if (currentGame && currentGame.status === 'ended' && !currentGame.eloUpdated) {
          updatePlayerRatings(currentGame);
          currentGame.eloUpdated = true;
          
          const p1 = currentGame.p1 || currentGame.whitePlayer;
          const p2 = currentGame.p2 || currentGame.blackPlayer;

          io.to(gameId).emit('volleyEnded', {
            winner: currentGame.winner,
            reason: currentGame.endReason || 'match_complete',
            score: currentGame.score,
            newRatings: {
              p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
              p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
            }
          });
        }
        clearInterval(syncInterval);
        return;
      }
      
      updateVolleyPhysics(currentGame);

      io.to(gameId).emit('volleyUpdate', {
        ballPos: currentGame.ballPos,
        paddle1Y: currentGame.paddle1Y,
        paddle2Y: currentGame.paddle2Y,
        score: currentGame.score
      });
    }, 32); // ~30fps
  }

  const PRESENCE_TTL_SECONDS = 30;
  const HEARTBEAT_MIN_MS = 10_000;
  const MAX_CONNECTIONS_PER_IP = 10;
  const BROADCAST_INTERVAL_MS = 5_000;

  const ipConnectionCount = new Map<string, number>();
  const heartbeatTimestamps = new Map<string, number>();
  const activeSessions = new Map<string, number>();

  function getClientIp(socket: any): string {
    return (
      (socket.handshake.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
      socket.handshake.address
    );
  }

  async function markSessionActive(sessionId: string): Promise<void> {
    activeSessions.set(sessionId, Date.now());
  }

  async function removeSession(sessionId: string): Promise<void> {
    activeSessions.delete(sessionId);
  }

  async function getActiveCount(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [sessionId, lastSeen] of activeSessions.entries()) {
      if (now - lastSeen > PRESENCE_TTL_SECONDS * 1000) {
        activeSessions.delete(sessionId);
      } else {
        count++;
      }
    }
    return count;
  }

  io.use((socket, next) => {
    const ip = getClientIp(socket);
    const current = ipConnectionCount.get(ip) ?? 0;

    if (current >= MAX_CONNECTIONS_PER_IP) {
      return next(new Error("Too many connections"));
    }

    socket.data.sessionId = randomUUID();
    socket.data.ip = ip;
    next();
  });

  io.on("connection", async (socket) => {
    const { sessionId, ip } = socket.data as { sessionId: string; ip: string };

    ipConnectionCount.set(ip, (ipConnectionCount.get(ip) ?? 0) + 1);
    await markSessionActive(sessionId);

    socket.on("heartbeat", async () => {
      const now = Date.now();
      const last = heartbeatTimestamps.get(sessionId) ?? 0;
      if (now - last < HEARTBEAT_MIN_MS) return;
      heartbeatTimestamps.set(sessionId, now);
      await markSessionActive(sessionId);
    });

    socket.on("disconnect", async () => {
      await removeSession(sessionId);
      heartbeatTimestamps.delete(sessionId);
      const count = (ipConnectionCount.get(ip) ?? 1) - 1;
      if (count <= 0) ipConnectionCount.delete(ip);
      else ipConnectionCount.set(ip, count);
    });
  });

  setInterval(async () => {
    try {
      const count = await getActiveCount();
      if (!Number.isInteger(count) || count < 0) return;
      io.emit("presence:update", { activeUsers: count });
    } catch {}
  }, BROADCAST_INTERVAL_MS);

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('findGame', async (playerData) => {
      const rating = await getOrSetRating(playerData.name);
      const playerWithRating = {
        ...playerData,
        socketId: socket.id,
        rating
      };
      players.set(socket.id, playerWithRating);

      if (waitingPlayers.length > 0) {
        const opponent = waitingPlayers.pop();
        const gameId = `${opponent.socketId}-${socket.id}`;
        
        // Randomly assign white and black
        const isWhite = Math.random() > 0.5;
        const whitePlayer = isWhite ? playerWithRating : opponent;
        const blackPlayer = isWhite ? opponent : playerWithRating;

        const game = {
          gameId,
          whitePlayer,
          blackPlayer,
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moves: [],
          status: 'active',
          mode: 'multiplayer' // indicate real online player vs player
        };

        games.set(gameId, game);

        socket.join(gameId);
        const opponentSocket = io.sockets.sockets.get(opponent.socketId);
        if (opponentSocket) opponentSocket.join(gameId);

        // Notify both players
        io.to(gameId).emit('gameStart', {
          gameId,
          whitePlayer,
          blackPlayer,
          fen: game.fen,
          mode: 'multiplayer'
        });
      } else {
        waitingPlayers.push(players.get(socket.id));
        socket.emit('waiting', 'Waiting for opponent...');
      }
    });

    socket.on('leaveQueue', () => {
      const index = waitingPlayers.findIndex((p: any) => p.socketId === socket.id);
      if (index !== -1) {
        waitingPlayers.splice(index, 1);
      }
    });

    socket.on('makeMove', async (data) => {
      const game = games.get(data.gameId);
      if (!game) return;

      game.fen = data.fen;
      game.moves.push(data.move);

      io.to(data.gameId).emit('moveMade', {
        move: data.move,
        fen: data.fen,
        moveNumber: game.moves.length
      });
    });

    socket.on('resign', (gameId) => {
      const game = games.get(gameId);
      if (game && game.status === 'active') {
        game.status = 'ended';
        let winner = 'opponent';
        if (game.whitePlayer) {
          winner = socket.id === game.whitePlayer.socketId ? 'black' : 'white';
        } else if (game.p1) {
          winner = socket.id === game.p1.socketId ? 'p2' : 'p1';
        }
        
        game.winner = winner;
        updatePlayerRatings(game);

        const p1 = game.p1 || game.whitePlayer;
        const p2 = game.p2 || game.blackPlayer;

        io.to(gameId).emit('gameEnded', {
          reason: 'resignation',
          winner: winner,
          newRatings: {
            p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
            p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
          }
        });
      }
    });

    socket.on('offerDraw', (gameId) => {
      const game = games.get(gameId);
      if (game) {
        let opponentId = null;
        if (game.whitePlayer && game.blackPlayer) {
          opponentId = socket.id === game.whitePlayer.socketId ? game.blackPlayer.socketId : game.whitePlayer.socketId;
        } else if (game.p1 && game.p2) {
          opponentId = socket.id === game.p1.socketId ? game.p2.socketId : game.p1.socketId;
        }
        
        if (opponentId) io.to(opponentId).emit('drawOffered');
      }
    });

    socket.on('acceptDraw', (gameId) => {
      const game = games.get(gameId);
      if (game) {
        game.status = 'ended';
        io.to(gameId).emit('gameEnded', {
          reason: 'draw',
          winner: 'draw'
        });
      }
    });

    socket.on('reportGameEnd', (data) => {
      const game = games.get(data.gameId);
      if (game && game.status === 'active') {
        game.status = 'ended';
        game.winner = data.winner;
        
        updatePlayerRatings(game);

        const p1 = game.p1 || game.whitePlayer;
        const p2 = game.p2 || game.blackPlayer;

        io.to(data.gameId).emit('gameEnded', {
          reason: data.reason || 'checkmate',
          winner: data.winner,
          newRatings: {
            p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
            p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
          }
        });
      }
    });

    socket.on('neonconnect_join', async (playerData) => {
      const playerWithRating = {
        ...playerData.profile,
        socketId: socket.id,
      };
      
      if (waitingNeonConnectPlayers.length > 0) {
        const opponent = waitingNeonConnectPlayers.pop();
        const gameId = `neonconnect-${opponent.socketId}-${socket.id}`;
        
        const game = {
          gameId,
          p1: opponent,
          p2: playerWithRating,
          status: 'active',
          type: 'neonconnect'
        };

        games.set(gameId, game);
        socket.join(gameId);
        const opponentSocket = io.sockets.sockets.get(opponent.socketId);
        if (opponentSocket) opponentSocket.join(gameId);

        // Notify both players
        io.to(opponent.socketId).emit('neonconnect_match', {
           opponent: playerWithRating.name,
           turn: true,
           playerId: 1 // HUMAN
        });
        io.to(socket.id).emit('neonconnect_match', {
           opponent: opponent.name,
           turn: false,
           playerId: 2 // OPPONENT
        });
      } else {
        waitingNeonConnectPlayers.push(playerWithRating);
      }
    });

    socket.on('neonconnect_move', (data) => {
      const gameId = Array.from(socket.rooms).find(r => r.startsWith('neonconnect-'));
      if (gameId) {
        socket.to(gameId).emit('neonconnect_opponent_move', { col: data.col });
      }
    });

     socket.on('neonconnect_reset', () => {
      const gameId = Array.from(socket.rooms).find(r => r.startsWith('neonconnect-'));
      if (gameId) {
        socket.to(gameId).emit('neonconnect_reset');
      }
    });

    // Volley (Ping Pong) Events
    socket.on('findVolleyGame', async (playerData) => {
      const mode = playerData.matchMode || 'classic';
      const rating = await getOrSetRating(playerData.name);
      const playerWithRating = {
        ...playerData,
        socketId: socket.id,
        rating
      };
      players.set(socket.id, playerWithRating);

      let queue = waitingVolleyQueues.get(mode);
      if (!queue) {
        queue = [];
        waitingVolleyQueues.set(mode, queue);
      }

      if (queue.length > 0) {
        const opponent = queue.pop();
        const gameId = `volley-${opponent.socketId}-${socket.id}`;
        
        const game = {
          gameId,
          p1: opponent,
          p2: players.get(socket.id),
          status: 'active',
          type: 'volley',
          matchMode: mode,
          score: { p1: 0, p2: 0 },
          ballPos: { x: 400, y: 250 },
          ballVel: { x: VOLLEY_START_SPEED, y: VOLLEY_START_SPEED },
          paddle1Y: 210,
          paddle2Y: 210,
          rematchRequested: { p1: false, p2: false }
        };

        games.set(gameId, game);
        socket.join(gameId);
        const opponentSocket = io.sockets.sockets.get(opponent.socketId);
        if (opponentSocket) opponentSocket.join(gameId);

        io.to(gameId).emit('volleyGameStart', game);
        startVolleyPhysicsLoop(gameId);
      } else {
        queue.push(players.get(socket.id));
        socket.emit('waiting', 'Scanning for volley signal...');
      }
    });

    socket.on('movePaddle', (data) => {
      const game = games.get(data.gameId);
      if (game) {
        if (data.player === 'p1') game.paddle1Y = data.paddleY;
        else game.paddle2Y = data.paddleY;
      }
    });

    socket.on('volleyResign', (gameId) => {
      const game = games.get(gameId);
      if (game && game.status === 'active') {
        game.status = 'ended';
        const winner = socket.id === game.p1.socketId ? game.p2.name : game.p1.name;
        game.winner = winner;
        game.endReason = 'resignation';
        
        updatePlayerRatings(game);
        game.eloUpdated = true;

        const p1 = game.p1;
        const p2 = game.p2;

        io.to(gameId).emit('volleyEnded', {
          winner: winner,
          reason: 'resignation',
          score: game.score,
          newRatings: {
            p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
            p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
          }
        });
      }
    });

    socket.on('volleyRequestRematch', (gameId) => {
      const game = games.get(gameId);
      if (game && game.status === 'ended') {
        if (socket.id === game.p1.socketId) game.rematchRequested.p1 = true;
        if (socket.id === game.p2.socketId) game.rematchRequested.p2 = true;

        if (game.rematchRequested.p1 && game.rematchRequested.p2) {
          // Reset game
          game.status = 'active';
          game.score = { p1: 0, p2: 0 };
          game.rematchRequested = { p1: false, p2: false };
          resetVolleyBall(game);
          io.to(gameId).emit('volleyGameReset', game);
          startVolleyPhysicsLoop(gameId);
        } else {
          // Notify other player
          socket.to(gameId).emit('rematchOffered');
        }
      }
    });

    // Trivia Events
    socket.on('findTriviaGame', async (data) => {
      const { profile, config } = data;
      const playerWithRating = {
        ...profile,
        socketId: socket.id,
        score: 0
      };
      players.set(socket.id, playerWithRating);

      if (config.mode === '1v1') {
        if (waitingTrivia1v1Queue.length > 0) {
          const opponent = waitingTrivia1v1Queue.pop();
          const gameId = `trivia-1v1-${opponent.socketId}-${socket.id}`;
          
          const randomTopic = predeterminedTopics[Math.floor(Math.random() * predeterminedTopics.length)];
          const aiQuestions = await generateTriviaQuestions(randomTopic.name);
          
          const game = {
            gameId,
            type: 'trivia',
            mode: '1v1',
            topic: randomTopic.name,
            players: [opponent, playerWithRating],
            questions: aiQuestions,
            currentQuestionIndex: 0,
            scores: { [opponent.name]: 0, [playerWithRating.name]: 0 },
            status: 'active',
            answeredCount: 0
          };

          games.set(gameId, game);
          socket.join(gameId);
          const opponentSocket = io.sockets.sockets.get(opponent.socketId);
          if (opponentSocket) opponentSocket.join(gameId);

          io.to(gameId).emit('triviaGameStart', {
            gameId,
            topic: game.topic,
            questions: game.questions,
            players: game.players
          });

          startTriviaGameLoop(gameId);
        } else {
          waitingTrivia1v1Queue.push(playerWithRating);
        }
      } else {
          // FFA Mode
          let ffaGame = Array.from(games.values()).find(g => g.type === 'trivia' && g.mode === 'ffa' && g.status === 'active' && g.players.length < 100);
          
          if (!ffaGame) {
              const gameId = `trivia-ffa-${Date.now()}`;
              
              const randomTopic = predeterminedTopics[Math.floor(Math.random() * predeterminedTopics.length)];
              const aiQuestions = await generateTriviaQuestions(randomTopic.name);
              
              ffaGame = {
                  gameId,
                  type: 'trivia',
                  mode: 'ffa',
                  topic: randomTopic.name,
                  players: [playerWithRating],
                  questions: aiQuestions,
                  currentQuestionIndex: 0,
                  scores: { [playerWithRating.name]: 0 },
                  status: 'active',
                  answeredCount: 0
              };
              games.set(gameId, ffaGame);
              socket.join(gameId);
              
              setTimeout(() => {
                io.to(gameId).emit('triviaGameStart', {
                    gameId,
                    topic: ffaGame.topic,
                    questions: ffaGame.questions,
                    players: ffaGame.players
                });
                startTriviaGameLoop(gameId);
              }, 5000);
          } else {
              ffaGame.players.push(playerWithRating);
              ffaGame.scores[playerWithRating.name] = 0;
              socket.join(ffaGame.gameId);
              
              socket.emit('triviaGameStart', {
                  gameId: ffaGame.gameId,
                  topic: ffaGame.topic,
                  questions: ffaGame.questions,
                  players: ffaGame.players,
                  currentQuestionIndex: ffaGame.currentQuestionIndex
              });
          }
      }
    });

    socket.on('triviaAnswer', (data) => {
        const { gameId, answerIndex, timeLeft } = data;
        const game = games.get(gameId);
        if (!game || game.status !== 'active') return;

        const player = players.get(socket.id);
        if (!player) return;

        const question = game.questions[game.currentQuestionIndex];
        if (answerIndex === question.correctAnswer) {
            const points = Math.ceil(timeLeft * 10);
            game.scores[player.name] += points;
            // Update player object in game.players too for sync
            const pObj = game.players.find((p: any) => p.name === player.name);
            if (pObj) pObj.score = game.scores[player.name];
        }

        game.answeredCount++;

        // Sync scores
        io.to(gameId).emit('triviaUpdate', {
            scores: game.scores,
            players: game.players
        });
    });

    function startTriviaGameLoop(gameId: string) {
        const game = games.get(gameId);
        if (!game) return;

        const interval = setInterval(() => {
            const g = games.get(gameId);
            if (!g || g.status !== 'active') {
                clearInterval(interval);
                return;
            }

            if (g.currentQuestionIndex < g.questions.length - 1) {
                g.currentQuestionIndex++;
                g.answeredCount = 0;
                io.to(gameId).emit('triviaNextQuestion', {
                    questionIndex: g.currentQuestionIndex
                });
            } else {
                g.status = 'ended';
                const sortedResults = Object.entries(g.scores)
                    .map(([name, score]) => ({ name, score }))
                    .sort((a: any, b: any) => b.score - a.score);
                
                const winner = sortedResults[0].name;
                g.winner = winner;

                // Simple rating update for trivia
                let ratingDelta = 0;
                if (g.mode === '1v1') {
                    // Update ratings via the common function
                    updatePlayerRatings(g);
                }

                io.to(gameId).emit('triviaEnded', {
                    winner,
                    results: sortedResults,
                    newRatings: g.mode === '1v1' ? {
                        rating: playerRatings.get(winner) || 0,
                        delta: 25 // Just a placeholder for the UI
                    } : null
                });
                
                clearInterval(interval);
                games.delete(gameId);
            }
        }, 17000); // 15s timer + 2s padding/reveal
    }

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      
      const chessIndex = waitingPlayers.findIndex((p: any) => p.socketId === socket.id);
      if (chessIndex !== -1) waitingPlayers.splice(chessIndex, 1);

      for (const [gameId, game] of games.entries()) {
        if (game.status === 'active' && 
            ((game.p1 && (game.p1.socketId === socket.id || game.p2?.socketId === socket.id)) ||
             (game.whitePlayer && (game.whitePlayer.socketId === socket.id || game.blackPlayer?.socketId === socket.id)))) {
          
          game.status = 'ended';
          let winner = 'opponent';
          let p1, p2;
          
          if (game.whitePlayer) {
            winner = socket.id === game.whitePlayer.socketId ? 'black' : 'white';
            p1 = game.whitePlayer; p2 = game.blackPlayer;
            io.to(gameId).emit('opponentDisconnected');
          } else {
            winner = socket.id === game.p1.socketId ? 'p2' : 'p1';
            p1 = game.p1; p2 = game.p2;
          }
          
          game.winner = winner;
          if (p1 && p2) updatePlayerRatings(game);
          
          io.to(gameId).emit('gameEnded', {
            reason: 'disconnect',
            winner,
            newRatings: {
              p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
              p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
            }
          });
        }
      }

      // Remove from waiting queue
      const neonIndex = waitingNeonConnectPlayers.findIndex(p => p.socketId === socket.id);
      if (neonIndex > -1) {
        waitingNeonConnectPlayers.splice(neonIndex, 1);
      }

      const triviaIndex = waitingTrivia1v1Queue.findIndex(p => p.socketId === socket.id);
      if (triviaIndex > -1) {
        waitingTrivia1v1Queue.splice(triviaIndex, 1);
      }

      for (let [mode, queue] of waitingVolleyQueues) {
        const idx = queue.findIndex(p => p.socketId === socket.id);
        if (idx > -1) {
          queue.splice(idx, 1);
        }
      }

      // End active games
      for (let [gameId, game] of games) {
        let isParticipant = false;
        if (game.whitePlayer && game.blackPlayer) {
          isParticipant = game.whitePlayer.socketId === socket.id || (game.blackPlayer.socketId === socket.id && !game.blackPlayer.isComputer);
        } else if (game.p1 && game.p2) {
          isParticipant = game.p1.socketId === socket.id || (game.p2.socketId === socket.id && !game.p2.isComputer);
        }

        if (isParticipant && game.status === 'active') {
          game.status = 'ended';
          
          if (game.type === 'volley') {
            const winnerName = socket.id === game.p1.socketId ? game.p2.name : game.p1.name;
            game.winner = winnerName;
            updatePlayerRatings(game);

            io.to(gameId).emit('volleyEnded', {
              winner: winnerName,
              reason: 'resignation',
              details: "Uplink severed. Opponent lost connection.",
              newRatings: {
                p1: { name: game.p1?.name, rating: playerRatings.get(game.p1?.name) ?? 0 },
                p2: { name: game.p2?.name, rating: playerRatings.get(game.p2?.name) ?? 0 }
              }
            });
          } else if (game.type === 'neonconnect') {
            io.to(gameId).emit('neonconnect_opponent_quit');
          } else if (game.type === 'trivia') {
             // Just end it or let others continue if FFA
             if (game.mode === '1v1') {
                 const winnerName = socket.id === game.players[0].socketId ? game.players[1].name : game.players[0].name;
                 io.to(gameId).emit('triviaEnded', {
                    winner: winnerName,
                    reason: 'opponent_left'
                 });
             } else {
                 // Remove from FFA players
                 game.players = game.players.filter((p: any) => p.socketId !== socket.id);
                 delete game.scores[socket.id];
                 io.to(gameId).emit('triviaUpdate', { scores: game.scores, players: game.players });
             }
          } else {
            const winner = socket.id === (game.p1?.socketId || game.whitePlayer?.socketId) ? 'opponent' : 'you';
            // Determine winner for Elo
            if (game.whitePlayer && game.blackPlayer) {
              game.winner = socket.id === game.whitePlayer.socketId ? 'black' : 'white';
            } else if (game.p1 && game.p2) {
              game.winner = socket.id === game.p1.socketId ? 'p2' : 'p1';
            }

            updatePlayerRatings(game);

            const p1 = game.p1 || game.whitePlayer;
            const p2 = game.p2 || game.blackPlayer;

            const reason = "Uplink severed. Connection loss detected. Match neutralized.";
            io.to(gameId).emit('opponentDisconnected', { 
              reason,
              newRatings: {
                p1: { name: p1?.name, rating: playerRatings.get(p1?.name) ?? 0 },
                p2: { name: p2?.name, rating: playerRatings.get(p2?.name) ?? 0 }
              }
            });
          }

          // Kill Stockfish engine if computer game
          if (gameId.startsWith('computer-') && engineInstances.has(gameId)) {
            const instance = engineInstances.get(gameId);
            if (instance && instance.engine.terminate) instance.engine.terminate();
            engineInstances.delete(gameId);
          }

          games.delete(gameId);
        }
      }

      players.delete(socket.id);
    });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server optimized for Cyber Safety.`);
    console.log(`Access securely via HTTPS through reverse proxy.`);
    console.log(`Internal uplink active on port ${PORT}`);
  });
}

startServer();
