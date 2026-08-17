// src/components/Asteroids/AsteroidsGame.tsx
//
// Routing shell for Neon Asteroids.
//
//   PRACTICE  lobby -> difficulty -> WagerModesMenu (Neon Bucks) -> Core
//   ONLINE    lobby -> 2×2 sector picker -> Core, in the chosen sector + mode
//
// ONLINE HAS NO WAGER OF ANY KIND this pass: no WagerModesMenu, no Neon Bucks,
// no stake, no pot. Picking one of the four online options goes straight to
// matchmaking. FREE PLAY is not an online option any more — the permanent
// world is practice-only from the UI's point of view.
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import AsteroidsLobby, {
  ONLINE_DIFFICULTY,
  type OnlineChoice,
  type OnlineSector,
} from './AsteroidsLobby';
import AsteroidsCore from './AsteroidsCore';
import { WagerModesMenu } from '../NeonBucks/WagerModesMenu';
import type { FreeplayMode } from '../../lib/freeplayNet';

interface AsteroidsGameProps {
  onExit: () => void;
  profile: { name: string; avatarUrl: string } | null;
  onGameStatusChange?: (inGame: boolean) => void;
}

const AsteroidsGame = ({ onExit, profile, onGameStatusChange }: AsteroidsGameProps) => {
  const [gameState, setGameState] = useState<'lobby' | 'wager' | 'playing'>('lobby');
  const [difficulty, setDifficulty] = useState(1);
  const [isMultiplayer, setIsMultiplayer] = useState(false);

  // Practice-only wager state (Neon Bucks). Never used on the online path.
  const [wagerAmount, setWagerAmount] = useState(0);
  const [wagerMode, setWagerMode] = useState<'free_play' | 'slayer' | 'lms' | null>(null);
  const [targetKills, setTargetKills] = useState<number | undefined>(undefined);
  const [selectedLobbyMode, setSelectedLobbyMode] = useState<'free_play' | 'slayer' | 'lms' | null>(null);

  // The ONLINE mode the player picked in the lobby — honored exactly (no
  // silent free-play fallback like the old isMultiplayer && wagerMode rule).
  const [onlineMode, setOnlineMode] = useState<FreeplayMode | null>(null);
  /** The ONLINE sector (eclipse/blitz). Null while practising. */
  const [onlineSector, setOnlineSector] = useState<OnlineSector | null>(null);

  React.useEffect(() => {
    onGameStatusChange?.(gameState !== 'lobby');
  }, [gameState, onGameStatusChange]);

  const handlePlayComputer = (diff: number, mode: 'free_play' | 'slayer' | 'lms') => {
    setDifficulty(diff);
    setIsMultiplayer(false);
    setOnlineMode(null);
    setOnlineSector(null);
    setSelectedLobbyMode(mode);
    setGameState('wager');
  };

  const handleStartWager = (stake: number, mode: 'free_play' | 'slayer' | 'lms', tkills?: number) => {
    setWagerAmount(stake);
    setWagerMode(mode);
    setTargetKills(tkills);
    setGameState('playing');
  };

  /** ONLINE entry: no wager menu, no Neon Bucks — straight to the server. */
  const handleFindGame = (choice: OnlineChoice) => {
    setIsMultiplayer(true);
    setOnlineMode(choice.mode);
    setOnlineSector(choice.sector);
    setSelectedLobbyMode(choice.mode);
    // The sector+mode pair IS a practice difficulty code (10..13), so hand the
    // core the matching one. AUTHORITY STAYS WITH THE SERVER: AsteroidsCore
    // ignores this prop online and draws the zone from the code the server
    // stamps on the match — this is only so the two never disagree.
    setDifficulty(ONLINE_DIFFICULTY[choice.sector][choice.mode]);
    // Hard-zero every practice wager field so nothing money-related can run.
    setWagerAmount(0);
    setWagerMode(null);
    setTargetKills(undefined);
    setGameState('playing');
  };

  return (
    <div className="h-full w-full bg-[#081616] relative flex justify-center">
      <AnimatePresence mode="wait">
        {(gameState === 'lobby' || gameState === 'wager') && (
          <motion.div
            key="lobby"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full relative z-0"
          >
            <AsteroidsLobby
                onFindGame={handleFindGame}
                onPlayComputer={handlePlayComputer}
                onExit={onExit}
            />
          </motion.div>
        )}
        {gameState === 'playing' && (
          <motion.div
            key="playing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full w-full absolute inset-0 z-10"
          >
            {/* `difficulty` carries the sector+mode as the practice code the
                zone sim understands; `onlineSector` is what the netcode puts
                on `freeplay:find`. */}
            <AsteroidsCore
              difficulty={difficulty}
              isMultiplayer={isMultiplayer}
              onlineMode={onlineMode}
              onlineSector={onlineSector}
              profile={profile}
              onExit={() => setGameState('lobby')}
              wagerAmount={wagerAmount}
              wagerMode={wagerMode}
              targetKills={targetKills}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Practice only — the online path never mounts this. */}
      {gameState === 'wager' && !isMultiplayer && (
        <div className="absolute inset-0 z-50">
          <WagerModesMenu
            gameTitle="Neon Asteroids"
            onCancel={() => setGameState('lobby')}
            onStart={handleStartWager}
            fixedMode={selectedLobbyMode || undefined}
            isMultiplayer={false}
          />
        </div>
      )}
    </div>
  );
};

export default AsteroidsGame;
