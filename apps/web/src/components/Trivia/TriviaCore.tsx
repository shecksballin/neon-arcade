import React, { useState } from 'react';
import { io, Socket } from 'socket.io-client';
import TriviaLobby from './TriviaLobby';
import TriviaGame from './TriviaGame';
import { WagerMenu } from '../NeonBucks/WagerMenu';

interface TriviaCoreProps {
  onExit: () => void;
  profile: any;
  onGameStatusChange?: (inGame: boolean) => void;
}

const socket: Socket = io();

const TriviaCore = ({ onExit, profile, onGameStatusChange }: TriviaCoreProps) => {
  const [view, setView] = useState<'lobby' | 'wager' | 'game'>('lobby');
  const [gameMode, setGameMode] = useState<'practice' | 'multiplayer'>('practice');
  const [matchConfig, setMatchConfig] = useState<{ mode: '1v1' | 'ffa' }>({ mode: '1v1' });

  const [practiceData, setPracticeData] = useState<{ topic: string, questions: any[] } | null>(null);
  const [wagerAmount, setWagerAmount] = useState<number>(0);

  const handleStartMultiplayer = (config: { mode: '1v1' | 'ffa' }) => {
    setGameMode('multiplayer');
    setMatchConfig(config);
    setPracticeData(null);
    setView('game');
    onGameStatusChange?.(true);
  };

  const handleStartPractice = (topic: string, questions: any[]) => {
    setPracticeData({ topic, questions });
    setView('wager');
  };

  return (
    <div className="h-full w-full relative h-[100vh] w-[100vw]">
      {view === 'wager' && (
        <div className="absolute inset-0 z-[100]">
          <WagerMenu
            gameTitle={`Neon Quiz: ${practiceData?.topic}`}
            onCancel={() => setView('lobby')}
            onStart={(stake) => {
              setWagerAmount(stake);
              setGameMode('practice');
              setView('game');
              onGameStatusChange?.(true);
            }}
          />
        </div>
      )}
      
      {view === 'lobby' || view === 'wager' ? (
        <TriviaLobby 
          onFindGame={handleStartMultiplayer} 
          onPlayPractice={handleStartPractice}
          onExit={onExit}
        />
      ) : (
        <TriviaGame 
          mode={gameMode} 
          config={matchConfig} 
          practiceQuestions={practiceData?.questions}
          topicName={practiceData?.topic}
          onExit={() => {
            setView('lobby');
            onGameStatusChange?.(false);
          }} 
          profile={profile}
          socket={socket}
          wagerAmount={wagerAmount}
        />
      )}
    </div>
  );
};

export default TriviaCore;
