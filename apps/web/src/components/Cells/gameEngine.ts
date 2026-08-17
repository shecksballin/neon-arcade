// src/components/Cells/gameEngine.ts
// Game Engine - Core Physics, AI, and Rendering Logic

export interface Cell {
  x: number;
  y: number;
  radius: number;
  velocityX: number;
  velocityY: number;
  mergeTimer: number;
  points: { angle: number; offset: number; velocity: number }[];
}

export interface Entity {
  id: string;
  nickname?: string;
  x: number;
  y: number;
  radius: number;
  mass: number;
  color: string;
  cells: Cell[];
  velocityX: number;
  velocityY: number;
  score: number;
  canSplit?: boolean;
  splitCooldown?: number;
  boostTimer?: number;
  isBoosting?: boolean;
  kills?: number;
  targetX?: number;
  targetY?: number;
  ai?: {
    nextDecision: number;
    searchRadius: number;
    currentTargetId?: string | null;
    evasionAngle?: number;
    personality?: 'passive' | 'balanced' | 'aggressive';
    orbitAngle?: number;
    reactionDelay?: number;
    frameCount?: number;
  };
}

export interface Food {
  x: number;
  y: number;
  radius: number;
  color: string;
  health?: string;
}

export interface Particle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radius: number;
  color: string;
  life: number;
}

export interface LeaderboardEntry {
  name: string;
  score: number;
  color: string;
  isPlayer: boolean;
}

export class GameEngine {
  width: number;
  height: number;
  worldWidth: number;
  worldHeight: number;
  gameState: 'menu' | 'playing' | 'gameOver';
  gameResult: 'win' | 'lost' | null;
  score: number;
  level: number;
  player: Entity;
  food: Food[];
  enemies: Entity[];
  particles: Particle[];
  camera: { x: number; y: number; zoom: number };
  mouseX: number;
  mouseY: number;
  mouseDown: boolean;
  leaderboard: LeaderboardEntry[];

  isMultiplayer: boolean;
  difficulty: number;
  killThreshold: number;
  zoneRadius: number;
  zoneX: number;
  zoneY: number;
  maxZoneRadius: number;
  zoneShrinkRate: number;
  outsideTimer: number;
  maxOutsideTime: number;
  zonePhase: number;
  isZoneShrinking: boolean;
  zonePhaseTimer: number;
  zoneStopDuration: number;

  // New Safe Zone and Timing Logic
  safeZone: { x: number; y: number; radius: number };
  nextSafeZone: { x: number; y: number; radius: number } | null;
  totalPlayTime: number;
  countdownTimer: number | null;
  phaseActiveDuration: number;

  constructor(canvasWidth: number, canvasHeight: number, isMultiplayer: boolean = false, difficulty: number = 3) {
    this.width = canvasWidth;
    this.height = canvasHeight;
    this.worldWidth = Math.max(canvasWidth * 6, 6000);
    this.worldHeight = Math.max(canvasHeight * 6, 6000);
    this.isMultiplayer = isMultiplayer;
    this.difficulty = difficulty;
    
    // Zone setup based on difficulty
    this.maxZoneRadius = Math.sqrt(Math.pow(this.worldWidth/2, 2) + Math.pow(this.worldHeight/2, 2));
    this.zoneRadius = this.maxZoneRadius;
    this.zoneX = 0;
    this.zoneY = 0;
    this.safeZone = { x: 0, y: 0, radius: this.maxZoneRadius };
    this.nextSafeZone = this.difficulty >= 10 ? this.generateNextSafeZone(this.safeZone) : null;
    this.totalPlayTime = 0;
    this.countdownTimer = null;
    
    // Base shrink rate (Slower red zone speed for Blitz: 600 -> 180 so it's outrunnable)
    this.zoneShrinkRate = (this.difficulty === 12 || this.difficulty === 13) ? 180 : 120;
    
    // Phase logic
    this.zonePhase = 1;
    this.isZoneShrinking = this.difficulty !== 1;
    // Phase 1 is 20s (previously 7.5s) to allow for the larger world size in Blitz
    this.phaseActiveDuration = (this.difficulty === 12 || this.difficulty === 13) ? 20 : 20;
    this.zonePhaseTimer = this.phaseActiveDuration;

    const stopDurations: { [key: number]: number } = {
      1: 99999, // Free Play (never starts)
      10: 20,   // Eclipse
      12: 8     // Blitz (shrunken stability/safe zone wait time)
    };
    this.zoneStopDuration = stopDurations[this.difficulty] ?? 30;
    
    // Outside timer setup
    const timers: { [key: number]: number } = {
      1: 99999, // Free Play
      10: 0,    // Eclipse (Instant kill per request)
      12: 0     // Blitz (Instant kill)
    };
    this.maxOutsideTime = timers[this.difficulty] ?? 10;
    this.outsideTimer = this.maxOutsideTime;

    // Standardized high difficulty bot stats
    this.killThreshold = 1.02;
    this.gameState = 'menu';
    this.score = 0;
    this.level = 1;

    const startX = 0;
    const startY = 0;

    // Player
    this.player = {
      id: 'player',
      x: startX,
      y: startY,
      radius: 15,
      mass: 1,
      color: '#00FFD1',
      cells: [{ 
        x: startX, 
        y: startY, 
        radius: 15,
        velocityX: 0,
        velocityY: 0,
        mergeTimer: 0,
        points: Array.from({ length: 24 }, (_, i) => ({
          angle: (i / 24) * Math.PI * 2,
          offset: 0,
          velocity: 0,
        }))
      }],
      velocityX: 0,
      velocityY: 0,
      boostTimer: 0,
      isBoosting: false,
      canSplit: true,
      splitCooldown: 0,
      score: 0,
      kills: 0
    };

    // Game objects
    this.food = [];
    this.enemies = [];
    this.particles = [];
    this.camera = { x: 0, y: 0, zoom: 1 };

    // Input
    this.mouseX = canvasWidth / 2;
    this.mouseY = canvasHeight / 2;
    this.mouseDown = false;

    // Leaderboard
    this.leaderboard = [];
    this.killNotifications = [];

    this.initializeFoodAndEnemies();
  }

  killNotifications: { name: string; x: number; y: number }[]; // Queue of killed entities with positions

  generateNextSafeZone(current: { x: number; y: number; radius: number }): { x: number; y: number; radius: number } {
    const shrinkFactor = (this.difficulty === 12 || this.difficulty === 13) ? 0.3 : 0.5; // next zone is smaller in Blitz
    const nextRadius = current.radius * shrinkFactor;

    // Random center that keeps next zone fully inside current
    const maxOffset = current.radius - nextRadius;
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * maxOffset;

    return {
      x: current.x + Math.cos(angle) * distance,
      y: current.y + Math.sin(angle) * distance,
      radius: nextRadius,
    };
  }

  initializeFoodAndEnemies() {
    this.food = [];
    this.enemies = [];
    this.particles = [];
    
    // Create food
    const foodCount = 1500;
    for (let i = 0; i < foodCount; i++) {
        this.food.push({
            x: (Math.random() - 0.5) * this.worldWidth,
            y: (Math.random() - 0.5) * this.worldHeight,
            radius: 8,
            color: '#00E0B7'
        });
    }

    const aiNames = [
        'CYBER_CORE', 'VOID_STALKER', 'NEON_WAVE', 'DELTA_9', 'XENON',
        'PROTO_MORPH', 'GHOST_ID', 'SYNTH_HEX', 'COBALT_EYE', 'VERTEX',
        'QUANTUM', 'OMEGA_RAY', 'VECTOR_X', 'SIGNAL_VOID', 'NULL_PTR'
    ];
 
    // Only create AI enemies if NOT multiplayer
    if (!this.isMultiplayer) {
      // Blitz starts with even more bots (180 + extra 50 requested)
      const enemyCount = (this.difficulty === 12 || this.difficulty === 13) ? 180 : 100; 
      for (let i = 0; i < enemyCount; i++) {
        // Safe spawn: Ensure AI is at least 600 units away from player
        let rx, ry, dist;
        do {
          rx = (Math.random() - 0.5) * this.worldWidth;
          ry = (Math.random() - 0.5) * this.worldHeight;
          dist = Math.hypot(rx - this.player.x, ry - this.player.y);
        } while (dist < 600);
 
        // Standardized Bot Stats (Equal difficulty across all modes)
        const searchRadius = 1000;
        const personalities: ('passive' | 'balanced' | 'aggressive')[] = ['passive', 'balanced', 'aggressive'];
        const personality = personalities[Math.floor(Math.random() * personalities.length)];

        // Uniform spawn size: strictly 15 mass units/radius
        const radius = 15;
        this.enemies.push({
          id: `ai_${i}`,
          nickname: aiNames[i % aiNames.length] + `_${Math.floor(Math.random() * 999)}`,
          x: rx,
          y: ry,
          radius: radius,
          mass: 1,
          cells: [{ 
            x: rx, 
            y: ry, 
            radius: radius,
            velocityX: 0,
            velocityY: 0,
            mergeTimer: 0,
            points: Array.from({ length: 24 }, (_, i) => ({
              angle: (i / 24) * Math.PI * 2,
              offset: 0,
              velocity: 0,
            }))
          }],
          velocityX: 0,
          velocityY: 0,
          targetX: rx,
          targetY: ry,
          color: `hsl(${Math.random() * 60 + 150}, 100%, 50%)`,
          ai: {
            nextDecision: 0,
            searchRadius: searchRadius,
            evasionAngle: (Math.random() - 0.5) * 0.4,
            personality: personality,
            orbitAngle: Math.random() * Math.PI * 2,
            reactionDelay: 6,
            frameCount: 0
          },
          canSplit: true,
          splitCooldown: 0,
          score: 0,
          kills: 0
        });
      }
    }
 
    this.updateLeaderboard();
  }

  setMousePos(x: number, y: number) {
    this.mouseX = x;
    this.mouseY = y;
  }

  setMouseDown(down: boolean) {
    this.mouseDown = down;
  }

  update(deltaTime: number) {
    if (this.gameState !== 'playing') return;

    const dt = deltaTime / 1000; // Convert to seconds

    // Update player
    this.updatePlayer(dt);

    // Update split cooldown for enemies
    this.enemies.forEach(enemy => {
      if (enemy.splitCooldown && enemy.splitCooldown > 0) {
        enemy.splitCooldown -= dt;
      } else {
        enemy.canSplit = true;
      }
    });

    this.enemies.forEach(enemy => {
      this.updateEnemy(enemy, dt);
    });

    // Remove dead enemies
    const deadEnemiesCount = this.enemies.length;
    this.enemies = this.enemies.filter(e => e.mass > 0);
    const removedCount = deadEnemiesCount - this.enemies.length;

    // Victory condition for Eclipse and Blitz
    if (this.enemies.length === 0 && !this.isMultiplayer && (this.difficulty >= 10)) {
      this.gameResult = 'win';
      this.gameState = 'gameOver';
      return;
    }

    // Respawn bots in Free Sector modes (< 10) ONLY
    if (!this.isMultiplayer && this.difficulty < 10 && removedCount > 0) {
      for (let i = 0; i < removedCount; i++) {
        let rx, ry, dist;
        do {
          rx = (Math.random() - 0.5) * this.worldWidth;
          ry = (Math.random() - 0.5) * this.worldHeight;
          dist = Math.hypot(rx - this.player.x, ry - this.player.y);
        } while (dist < 1000);

        const personalities: ('passive' | 'balanced' | 'aggressive')[] = ['passive', 'balanced', 'aggressive'];
        const personality = personalities[Math.floor(Math.random() * personalities.length)];
        const radius = 15;

        const aiNames = [
          'CYBER_CORE', 'VOID_STALKER', 'NEON_WAVE', 'DELTA_9', 'XENON',
          'PROTO_MORPH', 'GHOST_ID', 'SYNTH_HEX', 'COBALT_EYE', 'VERTEX',
          'QUANTUM', 'OMEGA_RAY', 'VECTOR_X', 'SIGNAL_VOID', 'NULL_PTR'
        ];

        this.enemies.push({
          id: `ai_respawn_${Date.now()}_${i}`,
          nickname: aiNames[Math.floor(Math.random() * aiNames.length)] + `_${Math.floor(Math.random() * 999)}`,
          x: rx,
          y: ry,
          radius: radius,
          mass: 1,
          cells: [{ 
            x: rx, y: ry, radius: radius,
            velocityX: 0, velocityY: 0, mergeTimer: 0,
            points: Array.from({ length: 24 }, (_, i) => ({
              angle: (i / 24) * Math.PI * 2, offset: 0, velocity: 0,
            }))
          }],
          velocityX: 0, velocityY: 0,
          targetX: rx, targetY: ry,
          color: `hsl(${Math.random() * 60 + 150}, 100%, 50%)`,
          ai: {
            nextDecision: 0,
            searchRadius: 1000,
            evasionAngle: (Math.random() - 0.5) * 0.4,
            personality: personality,
            orbitAngle: Math.random() * Math.PI * 2,
            reactionDelay: 6,
            frameCount: 0
          },
          canSplit: true,
          splitCooldown: 0,
          score: 0,
          kills: 0
        });
      }
    }

    // Handle collisions
    this.handleCollisions();

    // Remove dead food and regenerate
    this.food = this.food.filter(f => f.health !== 'dead');
    while (this.food.length < 1500) {
      // Spawn food uniformly across the world
      const rx = (Math.random() - 0.5) * this.worldWidth;
      const ry = (Math.random() - 0.5) * this.worldHeight;

      this.food.push({
        x: rx,
        y: ry,
        radius: 8,
        color: '#00E0B7'
      });
    }

    // Update camera
    this.updateCamera();

    // Update jiggle for all entities
    this.updateJiggle(this.player, dt);
    this.enemies.forEach(enemy => this.updateJiggle(enemy, dt));

    // Update particles
    this.particles = this.particles.filter(p => p.life > 0);
    this.particles.forEach(p => {
      p.x += p.velocityX * dt;
      p.y += p.velocityY * dt;
      p.life -= dt;
      p.radius *= 0.98;
    });

    // Update leaderboard
    this.updateLeaderboard();

    // Zone Shrinking Phases
    if (this.difficulty !== 1) {
      this.totalPlayTime += dt;
      this.zonePhaseTimer -= dt;

      if (this.zonePhaseTimer <= 0) {
        if (this.isZoneShrinking) {
          // Stop shrinking, start waiting
          this.isZoneShrinking = false;
          this.zonePhaseTimer = this.zoneStopDuration;
          this.countdownTimer = null;
          
          // If we were shrinking to a safe zone, update our "current" safe zone
          if (this.nextSafeZone) {
            this.safeZone = { ...this.nextSafeZone };
          } else {
            this.safeZone = { x: this.zoneX, y: this.zoneY, radius: this.zoneRadius };
          }
          
          // Pre-generate next target for visibility in stable phase (Difficulty 10+)
          if (this.difficulty >= 10) {
            this.nextSafeZone = this.generateNextSafeZone(this.safeZone);
          } else {
            this.nextSafeZone = null;
          }
        } else {
          // Stop waiting, start next shrink phase
          this.zonePhase++;
          this.isZoneShrinking = true;
          // Slower active time as play continues
          this.phaseActiveDuration = 20 + (this.totalPlayTime / 60) * 10;
          
          // Blitz override: balanced shrink after Phase 1
          if (this.difficulty === 12 || this.difficulty === 13) {
            // Slower shrink phases: 10s (previously 1.5s) for secondary phases
            this.phaseActiveDuration = this.zonePhase > 1 ? 10 : 20;
          }

          this.zonePhaseTimer = this.phaseActiveDuration;

          // Generate next target safe zone for advanced modes (if not already pre-generated for stable phase)
          if (this.difficulty >= 10 && !this.nextSafeZone) {
            this.nextSafeZone = this.generateNextSafeZone(this.safeZone);
          }
        }
      }
    }

    // Blitz Specific: 3s countdown before shrink starts
    if (!this.isZoneShrinking && (this.difficulty === 12 || this.difficulty === 13) && this.zonePhaseTimer <= 3) {
      this.countdownTimer = this.zonePhaseTimer;
    } else {
      this.countdownTimer = null;
    }

    if (this.isZoneShrinking) {
      if (this.difficulty >= 10 && this.nextSafeZone) {
        // Precise interpolation to reach target exactly at the end of the phase
        const totalRemaining = this.zonePhaseTimer + dt;
        const stepFraction = dt / totalRemaining;
        
        this.zoneX += (this.nextSafeZone.x - this.zoneX) * stepFraction;
        this.zoneY += (this.nextSafeZone.y - this.zoneY) * stepFraction;
        this.zoneRadius += (this.nextSafeZone.radius - this.zoneRadius) * stepFraction;
      } else {
        // Speed starts at 0.25 and increases by 0.25 every phase
        const currentSpeedMult = 0.25 * this.zonePhase;
        this.zoneRadius -= this.zoneShrinkRate * currentSpeedMult * dt;
      }
    }
    
    if (this.zoneRadius < 150) this.zoneRadius = 150; // Minimum zone size

    // Check if player is outside zone
    const playerDist = Math.hypot(this.player.x - this.zoneX, this.player.y - this.zoneY);
    if (playerDist > this.zoneRadius && this.difficulty !== 1) {
      // Instant kill for all zone modes
      this.gameResult = 'lost';
      this.gameState = 'gameOver';
    } else if (playerDist <= this.zoneRadius) {
      // Regenerate timer when back inside
      this.outsideTimer = Math.min(this.maxOutsideTime, this.outsideTimer + dt * 2);
    }

    // Infinite play - no win condition removed
  }

  updateJiggle(entity: Entity, dt: number) {
    const stiffness = 0.15;
    const damping = 0.8;
    const spread = 0.2;

    entity.cells.forEach(cell => {
      if (!cell.points) return;
      
      // Spring force back to rest
      cell.points.forEach(p => {
        const spring = -p.offset * stiffness;
        p.velocity += spring;
        p.velocity *= damping;
        p.offset += p.velocity;
      });

      // Spread wobble to neighbours
      const offsets = cell.points.map(p => p.offset);
      cell.points.forEach((p, i) => {
        const prev = offsets[(i - 1 + 24) % 24];
        const next = offsets[(i + 1) % 24];
        p.offset += (prev + next - 2 * p.offset) * spread;
      });
    });
  }

  triggerJiggle(cell: Cell, angle: number, force: number) {
    if (!cell.points) return;
    cell.points.forEach(p => {
      const diff = Math.abs(p.angle - angle) % (Math.PI * 2);
      const normalizedDiff = diff > Math.PI ? Math.PI * 2 - diff : diff;
      const proximity = Math.max(0, 1 - normalizedDiff / Math.PI);
      p.velocity += proximity * force;
    });
  }

  updatePlayer(dt: number) {
    // Calculate center of mass
    let totalMass = 0;
    let centerX = 0;
    let centerY = 0;

    this.player.cells.forEach(cell => {
      const radius = cell.radius;
      const mass = (radius * radius) / 100;
      totalMass += mass;
      centerX += cell.x * mass;
      centerY += cell.y * mass;
    });

    if (totalMass > 0) {
      centerX /= totalMass;
      centerY /= totalMass;
    }

    // Move towards mouse (camera relative)
    // The mouse input is usually in screen space. 
    // We need to convert it to world space relative to camera center.
    // However, simplification: the provided engine logic used:
    // const dx = this.mouseX - centerX;
    // but screenX = (x - cam.x) * zoom + canvas.width/2
    // So worldX = (screenX - canvas.width/2) / zoom + cam.x
    
    const worldMouseX = (this.mouseX - this.width / 2) / this.camera.zoom + this.camera.x;
    const worldMouseY = (this.mouseY - this.height / 2) / this.camera.zoom + this.camera.y;

    // Handle Boost
    let boostMultiplier = 1;
    if (this.player.isBoosting && this.player.boostTimer && this.player.boostTimer > 0) {
      boostMultiplier = 1.65;
      this.player.boostTimer = Math.max(0, this.player.boostTimer - dt);
    }

    this.player.cells.forEach(cell => {
      const dx = worldMouseX - cell.x;
      const dy = worldMouseY - cell.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist > 5) {
        // Increased player speed for better agility and outrunning the zone (3.2 -> 3.6, multiplier 40 -> 45)
        const speed = (3.6 / Math.sqrt(cell.radius) * 45) * boostMultiplier;
        cell.velocityX += (dx / dist) * speed;
        cell.velocityY += (dy / dist) * speed;
      }

      // Projectile decay
      const decay = Math.pow(0.9, dt * 60);
      cell.velocityX *= decay;
      cell.velocityY *= decay;

      cell.x += cell.velocityX * dt;
      cell.y += cell.velocityY * dt;

      if (cell.mergeTimer > 0) cell.mergeTimer -= dt;

      // Bounds
      if (cell.x < -this.worldWidth / 2) { cell.x = -this.worldWidth / 2; cell.velocityX *= -0.5; }
      if (cell.x > this.worldWidth / 2) { cell.x = this.worldWidth / 2; cell.velocityX *= -0.5; }
      if (cell.y < -this.worldHeight / 2) { cell.y = -this.worldHeight / 2; cell.velocityY *= -0.5; }
      if (cell.y > this.worldHeight / 2) { cell.y = this.worldHeight / 2; cell.velocityY *= -0.5; }
    });

    // Separation between sibling cells
    this.applyCellSeparation(this.player, dt);

    // Update player position (center of mass)
    this.player.x = centerX;
    this.player.y = centerY;

    // Calculate radius
    this.player.radius = Math.sqrt(
      this.player.cells.reduce((sum, cell) => sum + cell.radius * cell.radius, 0) / this.player.cells.length
    );

    // Update split cooldown
    if (this.player.splitCooldown && this.player.splitCooldown > 0) {
      this.player.splitCooldown -= dt;
    } else {
      this.player.canSplit = true;
    }
  }

  applyCellSeparation(entity: Entity, dt: number) {
    const cells = entity.cells;
    for (let i = 0; i < cells.length; i++) {
        const a = cells[i];
        if (a.radius <= 0) continue;

        for (let j = i + 1; j < cells.length; j++) {
            const b = cells[j];
            if (b.radius <= 0) continue;

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.hypot(dx, dy);
            const minDist = a.radius + b.radius;

            // Handle Merging Logic
            const isReadyToMerge = a.mergeTimer <= 0 && b.mergeTimer <= 0;

            if (isReadyToMerge) {
                // Aggressive pull towards each other
                const pullPower = 1500 * dt; // Much stronger pull
                const nx = dist === 0 ? 1 : dx / dist;
                const ny = dist === 0 ? 0 : dy / dist;

                const totalRadius = a.radius + b.radius;
                a.velocityX += nx * pullPower * (b.radius / totalRadius);
                a.velocityY += ny * pullPower * (b.radius / totalRadius);
                b.velocityX -= nx * pullPower * (a.radius / totalRadius);
                b.velocityY -= ny * pullPower * (a.radius / totalRadius);

                // If significantly overlapping, combine them
                if (dist < Math.max(a.radius, b.radius)) {
                    if (a.radius >= b.radius) {
                        a.radius = Math.sqrt(a.radius * a.radius + b.radius * b.radius);
                        b.radius = 0;
                        this.triggerJiggle(a, Math.atan2(dy, dx), 5);
                    } else {
                        b.radius = Math.sqrt(b.radius * b.radius + a.radius * a.radius);
                        a.radius = 0;
                        this.triggerJiggle(b, Math.atan2(-dy, -dx), 5);
                    }
                    continue;
                }
            } else {
                // Standard Collision / Separation
                if (dist < minDist) {
                    const overlap = minDist - dist;
                    const force = overlap * 50 * dt; // Stronger push for non-merging cells
                    const nx = dist === 0 ? 1 : dx / dist;
                    const ny = dist === 0 ? 0 : dy / dist;

                    const totalRadius = a.radius + b.radius;
                    a.velocityX -= nx * force * (b.radius / totalRadius);
                    a.velocityY -= ny * force * (b.radius / totalRadius);
                    b.velocityX += nx * force * (a.radius / totalRadius);
                    b.velocityY += ny * force * (a.radius / totalRadius);
                } else if (dist < minDist * 1.5) {
                    // Cohesion force for loose orbiting (only when not merging)
                    const cohesionPower = (dist - minDist) * 20 * dt;
                    const nx = dx / dist;
                    const ny = dy / dist;

                    const totalRadius = a.radius + b.radius;
                    a.velocityX += nx * cohesionPower * (b.radius / totalRadius);
                    a.velocityY += ny * cohesionPower * (b.radius / totalRadius);
                    b.velocityX -= nx * cohesionPower * (a.radius / totalRadius);
                    b.velocityY -= ny * cohesionPower * (a.radius / totalRadius);
                }
            }
        }
    }
    // Filter dead cells
    entity.cells = entity.cells.filter(c => c.radius > 5);
  }

  updateEnemy(enemy: Entity, dt: number) {
    if (!enemy.ai) return;
    
    // AI decision making
    enemy.ai.nextDecision -= dt;
    if (enemy.ai.nextDecision <= 0) {
      this.makeAIDecision(enemy);
      // Standardized high performance reaction time
      enemy.ai.nextDecision = 0.2 + (Math.random() * 0.3);
    }

    const targetX = enemy.targetX || enemy.x;
    const targetY = enemy.targetY || enemy.y;

    let totalMass = 0;
    let centerX = 0;
    let centerY = 0;

    enemy.cells.forEach(cell => {
      const radius = cell.radius;
      const mass = (radius * radius) / 100;
      totalMass += mass;
      centerX += cell.x * mass;
      centerY += cell.y * mass;

      const dx = targetX - cell.x;
      const dy = targetY - cell.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist > 5) {
        // Increased base enemy speed: 2.0 -> 2.8, mult: 40 -> 42
        const speed = 2.8 / Math.sqrt(cell.radius) * 42;
        cell.velocityX += (dx / dist) * speed;
        cell.velocityY += (dy / dist) * speed;
      } else {
        // Minimum velocity nudge to prevent freezing at target
        const nudgeSpeed = 10;
        cell.velocityX += (Math.random() - 0.5) * nudgeSpeed;
        cell.velocityY += (Math.random() - 0.5) * nudgeSpeed;
      }

      // Zone Urgency Force removed per user request: AI does not geet magical ultra speed and cannot outrun player artificially

      const decay = Math.pow(0.85, dt * 60);
      cell.velocityX *= decay;
      cell.velocityY *= decay;

      cell.x += cell.velocityX * dt;
      cell.y += cell.velocityY * dt;

      // Bounds
      if (cell.x < -this.worldWidth / 2) { cell.x = -this.worldWidth / 2; cell.velocityX *= -0.5; }
      if (cell.x > this.worldWidth / 2) { cell.x = this.worldWidth / 2; cell.velocityX *= -0.5; }
      if (cell.y < -this.worldHeight / 2) { cell.y = -this.worldHeight / 2; cell.velocityY *= -0.5; }
      if (cell.y > this.worldHeight / 2) { cell.y = this.worldHeight / 2; cell.velocityY *= -0.5; }

      // Zone Damage for AI per cell
      const cellDist = Math.hypot(cell.x - this.zoneX, cell.y - this.zoneY);
      if (cellDist > this.zoneRadius && this.difficulty !== 1) {
        cell.radius = 0; // Instant death for bots outside safe zone
      }
    });

    if (totalMass > 0) {
      centerX /= totalMass;
      centerY /= totalMass;
    }

    this.applyCellSeparation(enemy, dt);

    enemy.x = centerX;
    enemy.y = centerY;
    
    if (enemy.cells.length > 0) {
      enemy.radius = Math.sqrt(
        enemy.cells.reduce((sum, cell) => sum + cell.radius * cell.radius, 0) / enemy.cells.length
      );
    }

    // Filter out dead enemy cells
    enemy.cells = enemy.cells.filter(c => c.radius > 5);
    if (enemy.cells.length === 0) enemy.mass = 0;
  }

  private getPredictedPos(entity: Entity, frames: number = 30): { x: number; y: number } {
    // Basic prediction based on velocity
    // Actually cells don't have velocity directly in Entity, they have in Cell. 
    // Let's use the entity's apparent velocity calculated from cells center of mass change?
    // Or just use the velocity of the first cell as proxy.
    const cell = entity.cells[0];
    if (!cell) return { x: entity.x, y: entity.y };
    return {
      x: cell.x + (cell.velocityX || 0) * (frames / 60),
      y: cell.y + (cell.velocityY || 0) * (frames / 60),
    };
  }

  private getZoneUrgency(x: number, y: number): number {
    const dist = Math.hypot(x - this.zoneX, y - this.zoneY);
    const ratio = dist / this.zoneRadius;
    // Ramps from 0 at 70% distance to 1 at 95% distance
    return Math.max(0, Math.min(1, (ratio - 0.7) / 0.25));
  }

  makeAIDecision(enemy: Entity) {
    if (!enemy.ai) return;

    enemy.ai.frameCount = (enemy.ai.frameCount || 0) + 1;
    // Reaction delay: only think occasionally
    if (enemy.ai.frameCount % (enemy.ai.reactionDelay || 10) !== 0) return;

    const urgency = this.getZoneUrgency(enemy.x, enemy.y);
    const hasNextZone = this.nextSafeZone !== null && this.isZoneShrinking;
    
    let knowsNextZone = false;
    let isTop5InBlitz = false;

    if (this.difficulty === 10 || this.difficulty === 11) {
      knowsNextZone = true;
    } else if (this.difficulty === 12 || this.difficulty === 13) {
      const top5Names = this.leaderboard.slice(0, 5).map(e => e.name);
      if (enemy.nickname && top5Names.includes(enemy.nickname)) {
        knowsNextZone = true;
        isTop5InBlitz = true;
      }
    }

    const targetSafeArea = (knowsNextZone && this.nextSafeZone) 
      ? this.nextSafeZone 
      : { x: this.zoneX, y: this.zoneY, radius: this.zoneRadius };

    // Extreme urgency: outrunning the red zone. This applies to ALL bots (so they don't just sit and die).
    let isExtremeDanger = urgency > 0.8 || Math.hypot(enemy.x - this.zoneX, enemy.y - this.zoneY) > this.zoneRadius;
    
    // Top 5 bots in Blitz will consider being too far from the next safe zone center
    // as an extreme danger compared to threats, moving there first.
    if (isTop5InBlitz) {
        const distToSafest = Math.hypot(enemy.x - targetSafeArea.x, enemy.y - targetSafeArea.y);
        if (distToSafest > targetSafeArea.radius * 0.9) {
            isExtremeDanger = true;
        }
    }
    
    // In Eclipse, bots only step out of safe zone if they have to. We enforce keeping them within their target area when wandering/foraging.

    // 1. GATHER RELEVANT ENTITIES
    const searchRadius = enemy.ai.searchRadius;
    const fleeThreshold = this.killThreshold + 0.1;
    const chaseThreshold = 0.8;

    interface TargetInfo {
      id: string;
      x: number;
      y: number;
      radius: number;
      entity: Entity;
    }

    const others: TargetInfo[] = [];
    
    // Add other AI
    for (const other of this.enemies) {
      if (other.id === enemy.id) continue;
      const d = Math.hypot(other.x - enemy.x, other.y - enemy.y);
      if (d < searchRadius) {
        others.push({ id: other.id, x: other.x, y: other.y, radius: other.radius, entity: other });
      }
    }

    // Add player
    const playerDist = Math.hypot(this.player.x - enemy.x, this.player.y - enemy.y);
    if (playerDist < searchRadius) {
      others.push({ id: 'player', x: this.player.x, y: this.player.y, radius: this.player.radius, entity: this.player });
    }

    // Find Biggest Threat
    const threat = others
      .filter(c => c.radius > enemy.radius * fleeThreshold)
      .sort((a, b) => b.radius - a.radius)[0];

    // Find Best Prey (Only chase if reasonably safe or aggressive personality)
    const personality = enemy.ai.personality || 'balanced';
    const canHunt = urgency < 0.6 || personality === 'aggressive';
    const prey = canHunt ? others
      .filter(c => c.radius < enemy.radius * chaseThreshold)
      .sort((a, b) => b.radius - a.radius)[0] : null;

    let targetX = enemy.x;
    let targetY = enemy.y;
    let targetId: string | null = null;

    if (isExtremeDanger) {
      // PRIORITY 1: SAFETY (Fleeing the Red Zone)
      targetX = targetSafeArea.x;
      targetY = targetSafeArea.y;
      targetId = 'safety';
    } else if (threat) {
      // PRIORITY 2: FLEE
      targetId = threat.id;
      const predThreat = this.getPredictedPos(threat.entity, 20);
      targetX = enemy.x - (predThreat.x - enemy.x);
      targetY = enemy.y - (predThreat.y - enemy.y);
      
      const dx = targetX - enemy.x;
      const dy = targetY - enemy.y;
      const d = Math.hypot(dx, dy);
      if (d > 0) {
        targetX = enemy.x + (dx / d) * 1000;
        targetY = enemy.y + (dy / d) * 1000;
      }

      // Add "nudge" towards safety even while fleeing
      if (urgency > 0.3 || knowsNextZone) {
        const safeX = targetSafeArea.x;
        const safeY = targetSafeArea.y;

        if (isTop5InBlitz) {
          // Keep top 5 securely inside the next safe zone even when avoiding threats
          const distFromSafe = Math.hypot(enemy.x - safeX, enemy.y - safeY);
          let safePull = 0.3;
          if (distFromSafe > targetSafeArea.radius * 0.5) {
              // Pull harder to the center if fleeing takes them near the zone edge
              safePull = Math.min(1.0, (distFromSafe - targetSafeArea.radius * 0.5) / (targetSafeArea.radius * 0.3));
          }
          targetX = targetX * (1 - safePull) + safeX * safePull;
          targetY = targetY * (1 - safePull) + safeY * safePull;
        } else {
          targetX = targetX * 0.7 + safeX * 0.3;
          targetY = targetY * 0.7 + safeY * 0.3;
        }
      }
    } else if (prey) {
      // PRIORITY 3: CHASE
      targetId = prey.id;
      if (personality === 'aggressive' && enemy.canSplit && enemy.cells.length < 4 && enemy.radius > prey.radius * 2.5) {
        const distToPrey = Math.hypot(prey.x - enemy.x, prey.y - enemy.y);
        if (distToPrey < enemy.radius * 3) {
          this.splitAI(enemy, prey);
          return;
        }
      }

      const predPrey = this.getPredictedPos(prey.entity, 30);
      targetX = predPrey.x;
      targetY = predPrey.y;
      
      // Keep safety in mind
      let safePull = isTop5InBlitz ? 0.6 : (knowsNextZone ? 0.2 : (urgency > 0.4 ? 0.2 : 0));
      if (safePull > 0) {
        targetX = targetX * (1 - safePull) + targetSafeArea.x * safePull;
        targetY = targetY * (1 - safePull) + targetSafeArea.y * safePull;
      }
    } else {
      // PRIORITY 4: FORAGE/ORBIT
      const distToPlayer = Math.hypot(this.player.x - enemy.x, this.player.y - enemy.y);
      if (personality === 'balanced' && distToPlayer < searchRadius * 0.8) {
        const angle = Math.atan2(enemy.y - this.player.y, enemy.x - this.player.x);
        const orbitSpeed = 0.05;
        enemy.ai.orbitAngle = (enemy.ai.orbitAngle || angle) + orbitSpeed;
        const orbitRadius = this.player.radius * 3 + 100;
        
        targetX = this.player.x + Math.cos(enemy.ai.orbitAngle) * orbitRadius;
        targetY = this.player.y + Math.sin(enemy.ai.orbitAngle) * orbitRadius;
      } else {
        // FORAGE - Safe pellets only
        let nearestFood: Food | null = null;
        let minFoodDist = Infinity;

        for (const food of this.food) {
          // Only go for food inside their target safe area
          const foodDistToZone = Math.hypot(food.x - targetSafeArea.x, food.y - targetSafeArea.y);
          if (foodDistToZone > targetSafeArea.radius * 0.95) continue;

          const d = Math.hypot(food.x - enemy.x, food.y - enemy.y);
          if (d < minFoodDist && d < searchRadius) {
            minFoodDist = d;
            nearestFood = food;
          }
        }

        if (nearestFood) {
          targetX = nearestFood.x;
          targetY = nearestFood.y;

          let safePull = isTop5InBlitz ? 0.5 : (knowsNextZone ? 0.1 : 0);
          if (safePull > 0) {
            targetX = targetX * (1 - safePull) + targetSafeArea.x * safePull;
            targetY = targetY * (1 - safePull) + targetSafeArea.y * safePull;
          }
        } else {
          // Wandering/Center bias
          const safeX = targetSafeArea.x;
          const safeY = targetSafeArea.y;
          const currentAngle = Math.atan2(enemy.velocityY, enemy.velocityX) || Math.random() * Math.PI * 2;
          const newAngle = currentAngle + (Math.random() - 0.5) * 1;
          
          const wanderX = enemy.x + Math.cos(newAngle) * 800;
          const wanderY = enemy.y + Math.sin(newAngle) * 800;
          
          // Blend wander with center pull
          let pull = isTop5InBlitz ? 0.8 : (knowsNextZone ? 0.4 : 0.2);
          targetX = wanderX * (1 - pull) + safeX * pull;
          targetY = wanderY * (1 - pull) + safeY * pull;
        }
      }
    }

    enemy.targetX = targetX;
    enemy.targetY = targetY;
    enemy.ai.currentTargetId = targetId;
  }

  private splitAI(enemy: Entity, prey: { x: number; y: number }) {
    if (!enemy.canSplit || enemy.cells.length >= 4) return;
    
    enemy.canSplit = false;
    enemy.splitCooldown = 1.0;

    const angle = Math.atan2(prey.y - enemy.y, prey.x - enemy.x);
    const newCells: Cell[] = [];

    enemy.cells.forEach(cell => {
      if (cell.radius >= 25 && enemy.cells.length + newCells.length < 4) {
        const newRadius = cell.radius / Math.SQRT2;
        cell.radius = newRadius;
        
        const launchSpeed = 700;
        const newCell: Cell = {
          x: cell.x,
          y: cell.y,
          radius: newRadius,
          velocityX: cell.velocityX + Math.cos(angle) * launchSpeed,
          velocityY: cell.velocityY + Math.sin(angle) * launchSpeed,
          mergeTimer: 10,
          points: Array.from({ length: 24 }, (_, i) => ({
            angle: (i / 24) * Math.PI * 2,
            offset: 0,
            velocity: 0,
          }))
        };
        this.triggerJiggle(cell, angle + Math.PI, 15);
        this.triggerJiggle(newCell, angle, 25);
        newCells.push(newCell);
      }
    });

    enemy.cells.push(...newCells);
  }

  handleCollisions() {
    // Player cells eat food
    this.player.cells.forEach(cell => {
      for (let i = this.food.length - 1; i >= 0; i--) {
        const food = this.food[i];
        const dist = Math.hypot(cell.x - food.x, cell.y - food.y);

        if (dist < cell.radius) {
          this.food.splice(i, 1);
          cell.radius += 0.5;
          this.score += 1;
          this.player.score = this.score;

          this.triggerJiggle(cell, Math.random() * Math.PI * 2, 2);

          // Particle effect
          for (let j = 0; j < 3; j++) {
            this.particles.push({
              x: food.x,
              y: food.y,
              velocityX: (Math.random() - 0.5) * 200,
              velocityY: (Math.random() - 0.5) * 200,
              radius: 2,
              color: food.color,
              life: 0.3
            });
          }
        }
      }
    });

    // Enemies eat food
    this.enemies.forEach(enemy => {
      enemy.cells.forEach(cell => {
        for (let i = this.food.length - 1; i >= 0; i--) {
          const food = this.food[i];
          const dist = Math.hypot(cell.x - food.x, cell.y - food.y);

          if (dist < cell.radius) {
            this.food.splice(i, 1);
            cell.radius += 0.3;
            enemy.score += 1;
          }
        }
      });
    });

    // Player vs Enemies
    this.enemies.forEach(enemy => {
      this.player.cells.forEach(playerCell => {
        enemy.cells.forEach(enemyCell => {
          const dist = Math.hypot(playerCell.x - enemyCell.x, playerCell.y - enemyCell.y);
          
          if (playerCell.radius > enemyCell.radius * 1.1 && dist < playerCell.radius - enemyCell.radius * 0.3) {
            // Player cell eats enemy cell
            playerCell.radius += enemyCell.radius * 0.3;
            this.score += 20;
            this.player.score = this.score;
            this.triggerJiggle(playerCell, Math.atan2(enemyCell.y - playerCell.y, enemyCell.x - playerCell.x), 10);
            
            // Mark enemy cell as dead (0 radius)
            enemyCell.radius = 0;

            // Check if entire enemy is dead
            const aliveCells = enemy.cells.filter(c => c.radius > 5);
            if (aliveCells.length === 0 || (aliveCells.length === 1 && aliveCells[0] === enemyCell)) {
              if (this.player.kills !== undefined) this.player.kills++;
              if (enemy.nickname) this.killNotifications.push({ name: enemy.nickname, x: enemy.x, y: enemy.y });
            }

            // Reward Speed Boost (5 seconds, stackable)
            if (!this.player.boostTimer) this.player.boostTimer = 0;
            this.player.boostTimer += 5;
            
            for (let j = 0; j < 10; j++) {
              this.particles.push({
                x: enemyCell.x,
                y: enemyCell.y,
                velocityX: (Math.random() - 0.5) * 300,
                velocityY: (Math.random() - 0.5) * 300,
                radius: 4,
                color: enemy.color,
                life: 0.6
              });
            }
          } else if (enemyCell.radius > playerCell.radius * this.killThreshold && dist < enemyCell.radius - playerCell.radius * 0.3) {
            // Enemy cell eats player cell
            playerCell.radius = 0;
            this.triggerJiggle(enemyCell, Math.atan2(playerCell.y - enemyCell.y, playerCell.x - enemyCell.x), 10);
          }
        });
      });
      // Filter out dead enemy cells
      enemy.cells = enemy.cells.filter(c => c.radius > 5);
      if (enemy.cells.length === 0) enemy.mass = 0;
    });

    // Filter out dead player cells
    this.player.cells = this.player.cells.filter(c => c.radius > 5);
    if (this.player.cells.length === 0) {
      this.gameResult = 'lost';
      this.gameState = 'gameOver';
    }

    // Enemy vs Enemy
    for (let i = 0; i < this.enemies.length; i++) {
      for (let j = i + 1; j < this.enemies.length; j++) {
        const e1 = this.enemies[i];
        const e2 = this.enemies[j];
        
        e1.cells.forEach(c1 => {
          e2.cells.forEach(c2 => {
            const dist = Math.hypot(c1.x - c2.x, c1.y - c2.y);
            if (c1.radius > c2.radius * this.killThreshold && dist < c1.radius - c2.radius * 0.3) {
              c1.radius += c2.radius * 0.2;
              e1.score += 10;
              c2.radius = 0;
            } else if (c2.radius > c1.radius * this.killThreshold && dist < c2.radius - c1.radius * 0.3) {
              c2.radius += c1.radius * 0.2;
              e2.score += 10;
              c1.radius = 0;
            }
          });
        });
        e1.cells = e1.cells.filter(c => c.radius > 5);
        e2.cells = e2.cells.filter(c => c.radius > 5);
        if (e1.cells.length === 0) e1.mass = 0;
        if (e2.cells.length === 0) e2.mass = 0;
      }
    }
  }

  updateCamera() {
    // Follow player with smooth camera
    const targetX = this.player.x;
    const targetY = this.player.y;
    // Decreased expansion: Min zoom increased (0.3 -> 0.42), Ref radius increased (30 -> 45)
    // This keeps the FOV tighter as you grow.
    const targetZoom = Math.max(0.42, Math.min(1.5, 45 / this.player.radius));

    this.camera.x += (targetX - this.camera.x) * 0.1;
    this.camera.y += (targetY - this.camera.y) * 0.1;
    this.camera.zoom += (targetZoom - this.camera.zoom) * 0.05;
  }

  updateLeaderboard() {
    const all = [
      { name: 'You', score: this.player.score, color: '#00FFD1', isPlayer: true, id: 'player' },
      ...this.enemies.map((e) => ({
        name: e.nickname || 'UNKNOWN_AI',
        score: e.score,
        color: e.color,
        isPlayer: false,
        id: e.id
      }))
    ];

    this.leaderboard = all.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  merge() {
    if (this.player.cells.length <= 1) return;
    
    // Calculate total area and center of mass for a perfect instant merge
    let totalArea = 0;
    let cx = 0;
    let cy = 0;
    
    this.player.cells.forEach(cell => {
      const area = cell.radius * cell.radius;
      totalArea += area;
      cx += cell.x * area;
      cy += cell.y * area;
    });

    cx /= totalArea;
    cy /= totalArea;

    // Update the first cell to be the combined mass
    const mainCell = this.player.cells[0];
    mainCell.radius = Math.sqrt(totalArea);
    mainCell.x = cx;
    mainCell.y = cy;
    mainCell.velocityX = 0;
    mainCell.velocityY = 0;
    mainCell.mergeTimer = 0;

    // Retain only the combined cell
    this.player.cells = [mainCell];
    this.player.x = cx;
    this.player.y = cy;
    this.player.radius = mainCell.radius;

    // Visual feedback
    this.triggerJiggle(mainCell, 0, 15);
    
    // Create explosion particles
    for (let i = 0; i < 20; i++) {
        this.particles.push({
            x: cx + (Math.random() - 0.5) * mainCell.radius,
            y: cy + (Math.random() - 0.5) * mainCell.radius,
            velocityX: (Math.random() - 0.5) * 500,
            velocityY: (Math.random() - 0.5) * 500,
            radius: 3,
            color: '#00FFD1',
            life: 0.8
        });
    }
  }

  split() {
    if (!this.player.canSplit || this.player.cells.length >= 8) return;

    // Only split if large enough
    const minSplitRadius = 25;
    
    this.player.canSplit = false;
    this.player.splitCooldown = 0.5;

    const newCells: Cell[] = [];
    const worldMouseX = (this.mouseX - this.width / 2) / this.camera.zoom + this.camera.x;
    const worldMouseY = (this.mouseY - this.height / 2) / this.camera.zoom + this.camera.y;

    this.player.cells.forEach(cell => {
      if (cell.radius >= minSplitRadius && this.player.cells.length + newCells.length < 8) {
        const dx = worldMouseX - cell.x;
        const dy = worldMouseY - cell.y;
        const angle = Math.atan2(dy, dx);
        
        const newRadius = cell.radius / Math.SQRT2;
        cell.radius = newRadius;
        
        const launchSpeed = 800; // Pixels per second launch
        
        const newCell: Cell = {
          x: cell.x,
          y: cell.y,
          radius: newRadius,
          velocityX: cell.velocityX + Math.cos(angle) * launchSpeed,
          velocityY: cell.velocityY + Math.sin(angle) * launchSpeed,
          mergeTimer: 15, // 15 seconds before merge
          points: Array.from({ length: 24 }, (_, i) => ({
            angle: (i / 24) * Math.PI * 2,
            offset: 0,
            velocity: 0,
          }))
        };
        
        this.triggerJiggle(cell, angle + Math.PI, 15);
        this.triggerJiggle(newCell, angle, 25);
        
        newCells.push(newCell);
      }
    });

    this.player.cells.push(...newCells);
  }

  reset() {
    this.gameState = 'menu';
    this.gameResult = null;
    this.score = 0;

    // Reset Zone
    this.zoneRadius = this.maxZoneRadius;
    this.zoneX = 0;
    this.zoneY = 0;
    this.safeZone = { x: 0, y: 0, radius: this.maxZoneRadius };
    this.nextSafeZone = this.difficulty >= 10 ? this.generateNextSafeZone(this.safeZone) : null;
    this.totalPlayTime = 0;
    this.countdownTimer = null;
    this.zonePhase = 1;
    this.isZoneShrinking = (this.difficulty >= 10);
    this.zoneShrinkRate = (this.difficulty === 12 || this.difficulty === 13) ? 180 : 120;
    this.phaseActiveDuration = (this.difficulty === 12 || this.difficulty === 13) ? 20 : 20;
    this.zonePhaseTimer = this.phaseActiveDuration;

    const stopDurations: { [key: number]: number } = {
      1: 99999, // Free Play (never starts)
      10: 20,   // Eclipse
      12: 8     // Blitz (shrunken stability/safe zone wait time)
    };
    this.zoneStopDuration = stopDurations[this.difficulty] ?? 30;
    
    // Outside timer setup
    const timers: { [key: number]: number } = {
      1: 99999, // Free Play
      10: 0,    // Eclipse (Instant kill per request)
      12: 0     // Blitz (Instant kill)
    };
    this.maxOutsideTime = timers[this.difficulty] ?? 10;
    this.outsideTimer = this.maxOutsideTime;

    this.initializeFoodAndEnemies();
    this.player = {
      id: 'player',
      x: 0,
      y: 0,
      radius: 15,
      mass: 1,
      color: '#00FFD1',
      cells: [{ 
        x: 0, 
        y: 0, 
        radius: 15,
        velocityX: 0,
        velocityY: 0,
        mergeTimer: 0,
        points: Array.from({ length: 24 }, (_, i) => ({
          angle: (i / 24) * Math.PI * 2,
          offset: 0,
          velocity: 0,
        }))
      }],
      velocityX: 0,
      velocityY: 0,
      boostTimer: 0,
      isBoosting: false,
      canSplit: true,
      splitCooldown: 0,
      score: 0,
      kills: 0
    };
    this.camera = { x: 0, y: 0, zoom: 1 };
  }
}
