const fs = require('fs');
const glob = require('glob');

const files = [
  'src/components/Asteroids/AsteroidsLobby.tsx',
  'src/components/Cells/CellsLobby.tsx',
  'src/components/Chess/GameLobby.tsx',
  'src/components/Clumsy/ClumsyLobby.tsx',
  'src/components/Golf/GolfLobby.tsx',
  'src/components/Killer/KillerLobby.tsx',
  'src/components/Trivia/TriviaLobby.tsx',
  'src/components/Volley/VolleyLobby.tsx'
];

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  // 1. Add CircleDollarSign to lucide-react imports if not there
  if (content.includes('lucide-react') && !content.includes('CircleDollarSign')) {
    content = content.replace(/import \{([^}]+)\} from ["']lucide-react["'];/, (match, p1) => {
      return `import {${p1}, CircleDollarSign} from "lucide-react";`;
    });
  }

  // 2. We need to replace the entire cards section.
  // We can look for `<div className="w-full">` and then `</div>` ... wait, it's safer to do this manually or with a more robust replace.
  
});
