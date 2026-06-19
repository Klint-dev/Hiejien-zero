const { aiMove } = require("js-chess-engine");

const DIFFICULTIES = {
  beginner:     { label: "Beginner",     emoji: "🟢", elo: 800,  depth: 1 },
  intermediate: { label: "Intermediate", emoji: "🟡", elo: 1200, depth: 2 },
  advanced:     { label: "Advanced",     emoji: "🟠", elo: 1600, depth: 3 },
  master:       { label: "Master",       emoji: "🔴", elo: 2000, depth: 3 },
  grandmaster:  { label: "Grandmaster",  emoji: "🟣", elo: 2500, depth: 4 },
};

function getBestMove(fen, difficulty) {
  return new Promise((resolve, reject) => {
    try {
      const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.intermediate;
      const move = aiMove(fen, diff.depth);
      const [from, to] = Object.entries(move)[0];
      resolve(from.toLowerCase() + to.toLowerCase());
    } catch (e) {
      reject(new Error("Engine error: " + e.message));
    }
  });
}

module.exports = { getBestMove, DIFFICULTIES };
