export interface Question {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export const TRIVIA_QUESTIONS: Question[] = [
  // --- PHILOSOPHY ---
  {
    id: 'phil-1',
    question: "Which philosopher is famous for the 'Cave Allegory'?",
    options: ["Aristotle", "Socrates", "Plato", "Nietzsche"],
    correctAnswer: 2,
    category: "Philosophy",
    difficulty: "medium"
  },
  {
    id: 'phil-2',
    question: "Who is the author of 'Meditations', a seminal work on Stoic philosophy?",
    options: ["Seneca", "Marcus Aurelius", "Epictetus", "Zeno"],
    correctAnswer: 1,
    category: "Philosophy",
    difficulty: "easy"
  },
  {
    id: 'phil-3',
    question: "Which philosopher coined the phrase 'I think, therefore I am'?",
    options: ["St. Augustine", "René Descartes", "Immanuel Kant", "John Locke"],
    correctAnswer: 1,
    category: "Philosophy",
    difficulty: "easy"
  },
  {
    id: 'phil-4',
    question: "The concept of the 'Übermensch' (Overman) is associated with which thinker?",
    options: ["Arthur Schopenhauer", "Friedrich Nietzsche", "Hegel", "Karl Marx"],
    correctAnswer: 1,
    category: "Philosophy",
    difficulty: "hard"
  },
  {
    id: 'phil-5',
    question: "Who wrote 'The Republic'?",
    options: ["Plato", "Aristotle", "Herodotus", "Xenophon"],
    correctAnswer: 0,
    category: "Philosophy",
    difficulty: "medium"
  },

  // --- SCIENCE ---
  {
    id: 'sci-1',
    question: "What is the speed of light in a vacuum (approximately)?",
    options: ["299,792,458 m/s", "150,000,000 m/s", "1,000,000,000 m/s", "343 m/s"],
    correctAnswer: 0,
    category: "Science",
    difficulty: "hard"
  },
  {
    id: 'sci-2',
    question: "Which particle is responsible for giving other particles mass according to the Standard Model?",
    options: ["Electron", "Photon", "Higgs Boson", "Neutrino"],
    correctAnswer: 2,
    category: "Science",
    difficulty: "hard"
  },
  {
    id: 'sci-3',
    question: "What is the most abundant gas in Earth's atmosphere?",
    options: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Argon"],
    correctAnswer: 2,
    category: "Science",
    difficulty: "easy"
  },
  {
    id: 'sci-4',
    question: "What temperature is absolute zero in Celsius?",
    options: ["0°C", "-100°C", "-273.15°C", "-459.67°C"],
    correctAnswer: 2,
    category: "Science",
    difficulty: "medium"
  },
  {
    id: 'sci-5',
    question: "Which element has the highest melting point?",
    options: ["Iron", "Carbon", "Tungsten", "Platinum"],
    correctAnswer: 2,
    category: "Science",
    difficulty: "medium"
  },

  // --- TECH ---
  {
    id: 'tech-1',
    question: "Who is considered the 'father' of the modern computer?",
    options: ["Steve Jobs", "Bill Gates", "Alan Turing", "Charles Babbage"],
    correctAnswer: 3,
    category: "Tech",
    difficulty: "medium"
  },
  {
    id: 'tech-2',
    question: "What does AI stand for in computer science?",
    options: ["Automated Integration", "Artificial Intelligence", "Advanced Interface", "Algorithmic Index"],
    correctAnswer: 1,
    category: "Tech",
    difficulty: "easy"
  },
  {
    id: 'tech-3',
    question: "Which programming language was created by Bjarne Stroustrup?",
    options: ["Java", "C++", "Python", "Rust"],
    correctAnswer: 1,
    category: "Tech",
    difficulty: "medium"
  },
  {
    id: 'tech-4',
    question: "What year was the first iPhone released?",
    options: ["2005", "2006", "2007", "2008"],
    correctAnswer: 2,
    category: "Tech",
    difficulty: "easy"
  },
  {
    id: 'tech-5',
    question: "In networking, what does VPN stand for?",
    options: ["Very Private Network", "Virtual Public Network", "Virtual Private Network", "Verified Pro Network"],
    correctAnswer: 2,
    category: "Tech",
    difficulty: "easy"
  },

  // --- POP CULTURE ---
  {
    id: 'pop-1',
    question: "Which artist released the iconic 1982 album 'Thriller'?",
    options: ["Michael Jackson", "Prince", "Madonna", "David Bowie"],
    correctAnswer: 0,
    category: "Pop Culture",
    difficulty: "easy"
  },
  {
    id: 'pop-2',
    question: "In the 'Matrix' trilogy, what color is the pill Neo takes to see reality?",
    options: ["Blue", "Red", "Green", "Yellow"],
    correctAnswer: 1,
    category: "Pop Culture",
    difficulty: "easy"
  },
  {
    id: 'pop-3',
    question: "Which movie holds the record for the highest-grossing film of all time?",
    options: ["Titanic", "Avengers: Endgame", "Avatar", "Star Wars"],
    correctAnswer: 2,
    category: "Pop Culture",
    difficulty: "medium"
  },
  {
    id: 'pop-4',
    question: "Who played the character of Jack Sparrow in 'Pirates of the Caribbean'?",
    options: ["Brad Pitt", "Johnny Depp", "Orlando Bloom", "Tom Cruise"],
    correctAnswer: 1,
    category: "Pop Culture",
    difficulty: "easy"
  },
  {
    id: 'pop-5',
    question: "Which fictional city is the home of Batman?",
    options: ["Metropolis", "Gotham City", "Star City", "Central City"],
    correctAnswer: 1,
    category: "Pop Culture",
    difficulty: "easy"
  },

  // --- RAP ---
  {
    id: 'rap-1',
    question: "Who is the artist behind the 1994 album 'Illmatic'?",
    options: ["Jay-Z", "The Notorious B.I.G.", "Nas", "Snoop Dogg"],
    correctAnswer: 2,
    category: "Rap",
    difficulty: "medium"
  },
  {
    id: 'rap-2',
    question: "Which rap group released the legendary album 'Enter the Wu-Tang (36 Chambers)'?",
    options: ["N.W.A", "Wu-Tang Clan", "Outkast", "A Tribe Called Quest"],
    correctAnswer: 1,
    category: "Rap",
    difficulty: "easy"
  },
  {
    id: 'rap-3',
    question: "What is the birthplace of hip-hop?",
    options: ["Compton", "The Bronx", "Harlem", "Brooklyn"],
    correctAnswer: 1,
    category: "Rap",
    difficulty: "easy"
  },
  {
    id: 'rap-4',
    question: "Who holds the record for the most Grammys won by a rap artist (as of 2024)?",
    options: ["Eminem", "Jay-Z", "Kanye West", "Kendrick Lamar"],
    correctAnswer: 1,
    category: "Rap",
    difficulty: "medium"
  },
  {
    id: 'rap-5',
    question: "Which artist is known as the 'Godfather of Grime'?",
    options: ["Skepta", "Wiley", "Stormzy", "Dizzee Rascal"],
    correctAnswer: 1,
    category: "Rap",
    difficulty: "medium"
  },

  // --- BASKETBALL ---
  {
    id: 'bb-1',
    question: "How many NBA championships did Michael Jordan win with the Chicago Bulls?",
    options: ["4", "5", "6", "7"],
    correctAnswer: 2,
    category: "Basketball",
    difficulty: "easy"
  },
  {
    id: 'bb-2',
    question: "Who holds the record for the most points scored in a single NBA game?",
    options: ["Kobe Bryant", "Michael Jordan", "Wilt Chamberlain", "LeBron James"],
    correctAnswer: 2,
    category: "Basketball",
    difficulty: "medium"
  },
  {
    id: 'bb-3',
    question: "Which team has the most NBA championship titles in history (as of 2024)?",
    options: ["Los Angeles Lakers", "Chicago Bulls", "Boston Celtics", "Golden State Warriors"],
    correctAnswer: 2,
    category: "Basketball",
    difficulty: "medium"
  },
  {
    id: 'bb-4',
    question: "Which player has the most career assists in NBA history?",
    options: ["Jason Kidd", "John Stockton", "Chris Paul", "Magic Johnson"],
    correctAnswer: 1,
    category: "Basketball",
    difficulty: "hard"
  },
  {
    id: 'bb-5',
    question: "What is the height of an official NBA basketball hoop in feet?",
    options: ["9", "10", "11", "12"],
    correctAnswer: 1,
    category: "Basketball",
    difficulty: "easy"
  },

  // --- UFC ---
  {
    id: 'ufc-1',
    question: "Which fighter holds the record for the fastest knockout (KO) in UFC history?",
    options: ["Conor McGregor", "Jorge Masvidal", "Anderson Silva", "Jon Jones"],
    correctAnswer: 1,
    category: "UFC",
    difficulty: "medium"
  },
  {
    id: 'ufc-2',
    question: "Which weight class did Khabib Nurmagomedov dominate before retiring undefeated?",
    options: ["Featherweight", "Lightweight", "Welterweight", "Middleweight"],
    correctAnswer: 1,
    category: "UFC",
    difficulty: "medium"
  },
  {
    id: 'ufc-3',
    question: "Who was the first woman to be inducted into the UFC Hall of Fame?",
    options: ["Ronda Rousey", "Amanda Nunes", "Cris Cyborg", "Holly Holm"],
    correctAnswer: 0,
    category: "UFC",
    difficulty: "easy"
  },
  {
    id: 'ufc-4',
    question: "In which city was UFC 1 held in 1993?",
    options: ["Las Vegas", "Denver", "Atlantic City", "Chicago"],
    correctAnswer: 1,
    category: "UFC",
    difficulty: "hard"
  },
  {
    id: 'ufc-5',
    question: "Which fighter is known as 'The Spider'?",
    options: ["Anderson Silva", "Jose Aldo", "Israel Adesanya", "Kamaru Usman"],
    correctAnswer: 0,
    category: "UFC",
    difficulty: "easy"
  }
];
