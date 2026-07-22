const fs = require('fs');

const files = [
  'src/components/Asteroids/AsteroidsLobby.tsx',
  'src/components/Cells/CellsLobby.tsx',
  'src/components/Chess/GameLobby.tsx',
  'src/components/Clumsy/ClumsyLobby.tsx',
  'src/components/Golf/GolfLobby.tsx',
  'src/components/Killer/KillerLobby.tsx',
  'src/components/Trivia/TriviaLobby.tsx',
  'src/components/Volley/VolleyLobby.tsx',
  'src/components/NeonConnect/NeonConnectGame.tsx'
];

files.forEach(file => {
  if (!fs.existsSync(file)) return;
  let code = fs.readFileSync(file, 'utf8');

  // Ensure CircleDollarSign is imported
  if (code.includes('lucide-react') && !code.includes('CircleDollarSign')) {
    code = code.replace(/import\s+\{([^}]+)\}\s+from\s+['"]lucide-react['"];/, (m, p1) => {
      return `import { ${p1.trim()}, CircleDollarSign } from 'lucide-react';`;
    });
  }

  fs.writeFileSync(file, code);
});
