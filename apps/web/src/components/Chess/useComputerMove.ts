import { useCallback } from "react";

export function useComputerMove() {
  const getBestMove = useCallback(
    async (fen: string, { depth = 15, skillLevel = 10 } = {}) => {
      try {
        const response = await fetch("/api/chess/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fen, difficulty: skillLevel, depth }),
        });
        const data = await response.json();
        return data.move;
      } catch (err) {
        console.error("Failed to fetch computer move:", err);
        return "";
      }
    },
    []
  );

  return { getBestMove };
}

