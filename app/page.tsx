"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";

// ====== Types ======

type Suit = "hearts" | "diamonds" | "clubs" | "spades" | "joker";

type Card = {
  id: string;
  rank: string; // 'A', '2', ... 'K' or 'JOKER'
  suit: Suit;
  color: "red" | "black";
  jokerImage?: string | null;
};

type PlayerRow = (Card | null)[];

type PlayerBoard = {
  id: string;
  name: string;
  isHost: boolean;
  handRow: PlayerRow; // 22 slots: 21 + 1 empty
  tableRow: PlayerRow; // 22 slots: 21 + 1 empty
  submitted: boolean;
  finished: boolean;
};

type GameStatus = "lobby" | "playing" | "finished";

type LastDiscardInfo = {
  ownerId: string | null;
  fromRow: "hand" | "table" | null;
  fromIndex: number | null;
  faceDown: boolean;
};

type TrumpRequest = {
  requesterId: string;
  approverId: string;
  status: "pending" | "approved" | "rejected";
};

type GameState = {
  id: string;
  inviteCode: string;
  status: GameStatus;
  hostId: string;
  playerOrder: string[];
  activePlayerId: string;
  deck: Card[];
  discardPile: Card[];
  players: Record<string, PlayerBoard>;
  lastDiscardInfo: LastDiscardInfo;
  hasDrawnThisTurn: boolean;
  hasDiscardedThisTurn: boolean;

  // 🔹 Trump fields
  trumpCard: Card | null;
  trumpViewers: string[]; // players who are allowed to see trump face
  pendingTrumpRequest: TrumpRequest | null;
};

type DragInfo = {
  fromRow: "hand" | "table";
  fromIndex: number;
} | null;

// ====== Helper constants & functions ======

const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];
const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];

// 🔧 OPTION A: simple list of joker images by naming convention
// Put joker1.png, joker2.png, ... joker20.png in /public/jokers/
// If you add more later, just increase { length: XX } accordingly.
const JOKER_IMAGES = Array.from(
  { length: 30 },
  (_, i) => `/jokers/joker${i + 1}.png`
);

function randomId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickJokerImages(): string[] {
  const shuffled = shuffle(JOKER_IMAGES);
  // we only need 9 joker images per game
  return shuffled.slice(0, 9);
}

// 3 decks + 9 jokers => 165 cards
function generateDeck(): Card[] {
  const cards: Card[] = [];

  // 3 standard decks (3 * 52)
  for (let d = 0; d < 3; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        const color: "red" | "black" =
          suit === "hearts" || suit === "diamonds" ? "red" : "black";
        cards.push({
          id: randomId(),
          rank,
          suit,
          color,
          jokerImage: null,
        });
      }
    }
  }

  // 9 jokers with random images
  const jokerImages = pickJokerImages();
  for (let j = 0; j < 9; j++) {
    cards.push({
      id: randomId(),
      rank: "JOKER",
      suit: "joker",
      color: "red",
      jokerImage: jokerImages[j],
    });
  }

  return shuffle(cards);
}

// Move card within same row (shifting – no duplicates)
function moveWithinRow(
  row: PlayerRow,
  fromIndex: number,
  toIndex: number
): PlayerRow {
  const newRow = [...row];
  const [card] = newRow.splice(fromIndex, 1);
  newRow.splice(toIndex, 0, card);
  return newRow;
}

/**
 * Move one card from fromRow to toRow (between lines).
 *
 * Behaviour:
 * - Remove card from fromRow at fromIndex, push a null to keep 22 slots.
 * - Insert card into toRow at toIndex, shifting cards.
 * - Then remove the **last null** from toRow (so we don't accidentally drop a real card).
 */
function moveBetweenRows(
  fromRow: PlayerRow,
  toRow: PlayerRow,
  fromIndex: number,
  toIndex: number
): { newFrom: PlayerRow; newTo: PlayerRow } {
  const newFrom = [...fromRow];
  const newTo = [...toRow];

  const [card] = newFrom.splice(fromIndex, 1);
  newFrom.push(null); // keep length 22

  newTo.splice(toIndex, 0, card);

  const lastNullIndex = newTo.lastIndexOf(null);
  if (lastNullIndex !== -1) {
    newTo.splice(lastNullIndex, 1);
  } else {
    newTo.pop();
  }

  return { newFrom, newTo };
}

// Advance active player clockwise
function advanceTurn(state: GameState): GameState {
  const idx = state.playerOrder.indexOf(state.activePlayerId);
  const nextIdx = (idx + 1) % state.playerOrder.length;
  return {
    ...state,
    activePlayerId: state.playerOrder[nextIdx],
    hasDrawnThisTurn: false,
    hasDiscardedThisTurn: false,
  };
}

// ====== Component ======

const HomePage: React.FC = () => {
  const [playerName, setPlayerName] = useState<string>("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [inviteCodeInput, setInviteCodeInput] = useState<string>("");
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [joinMode, setJoinMode] = useState<"none" | "host" | "join">("none");
  const [channel, setChannel] = useState<any>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);

  // drag info for mouse
  const [dragInfo, setDragInfo] = useState<DragInfo>(null);
  // tap selection for touch (and click) – to move cards between rows
  const [tapSelection, setTapSelection] = useState<DragInfo>(null);

  const [chosenFirstPlayerId, setChosenFirstPlayerId] = useState<string | null>(
    null
  );

  // 🔹 persistent identity & last session info
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      let stored = window.localStorage.getItem("cardgame_player_id");
      if (!stored) {
        stored = randomId();
        window.localStorage.setItem("cardgame_player_id", stored);
      }
      setPlayerId(stored);

      const savedName = window.localStorage.getItem("cardgame_player_name");
      if (savedName) setPlayerName(savedName);
    } catch (err) {
      console.warn("localStorage not available, using ephemeral ID", err);
      setPlayerId(randomId());
    }
  }, []);

  // Create Supabase realtime channel when inviteCode is set
  useEffect(() => {
    if (!inviteCode || !playerId) return;

    const ch = supabase.channel(`game-${inviteCode}`, {
      config: {
        broadcast: { ack: true },
      },
    });

    // 1) Listen for full state updates
    ch.on("broadcast", { event: "state" }, (payload: any) => {
      const state = payload.payload as GameState;
      setGameState(state);
    });

    // 2) Listen for join requests (only host processes these)
    ch.on("broadcast", { event: "join" }, (payload: any) => {
      const data = payload.payload as { playerId: string; name: string };

      setGameState((current) => {
        if (!current) return current;
        if (current.hostId !== playerId) return current; // only host
        if (current.players[data.playerId]) return current;
        if (current.status !== "lobby") return current;
        if (current.playerOrder.length >= 5) return current;

        const newPlayer: PlayerBoard = {
          id: data.playerId,
          name: data.name,
          isHost: false,
          handRow: Array(22).fill(null),
          tableRow: Array(22).fill(null),
          submitted: false,
          finished: false,
        };

        const newPlayers = { ...current.players, [data.playerId]: newPlayer };
        const newState: GameState = {
          ...current,
          players: newPlayers,
          playerOrder: [...current.playerOrder, data.playerId],
        };

        ch.send({
          type: "broadcast",
          event: "state",
          payload: newState,
        });

        return newState;
      });
    });

    // 3) New clients ask for latest state
    ch.on("broadcast", { event: "request_state" }, () => {
      setGameState((current) => {
        if (!current) return current;
        ch.send({
          type: "broadcast",
          event: "state",
          payload: current,
        });
        return current;
      });
    });

    ch.subscribe();
    setChannel(ch);

    // Ask host for latest state
    ch.send({
      type: "broadcast",
      event: "request_state",
      payload: {},
    });

    return () => {
      setChannel(null);
      supabase.removeChannel(ch);
    };
  }, [inviteCode, playerId]);

  // After channel ready, host/join sends initial messages
  useEffect(() => {
    if (!channel || !playerId || !playerName) return;

    if (joinMode === "join") {
      channel.send({
        type: "broadcast",
        event: "join",
        payload: { playerId, name: playerName },
      });
    }

    if (joinMode === "host") {
      setGameState((prev) => {
        if (prev) return prev;

        const initialPlayer: PlayerBoard = {
          id: playerId,
          name: playerName,
          isHost: true,
          handRow: Array(22).fill(null),
          tableRow: Array(22).fill(null),
          submitted: false,
          finished: false,
        };

        const newState: GameState = {
          id: randomId(),
          inviteCode: inviteCode || "",
          status: "lobby",
          hostId: playerId,
          playerOrder: [playerId],
          activePlayerId: playerId,
          deck: [],
          discardPile: [],
          players: { [playerId]: initialPlayer },
          lastDiscardInfo: {
            ownerId: null,
            fromRow: null,
            fromIndex: null,
            faceDown: false,
          },
          hasDrawnThisTurn: false,
          hasDiscardedThisTurn: false,
          trumpCard: null,
          trumpViewers: [],
          pendingTrumpRequest: null,
        };

        channel.send({
          type: "broadcast",
          event: "state",
          payload: newState,
        });

        return newState;
      });
    }
  }, [channel, joinMode, playerId, playerName, inviteCode]);

  const me: PlayerBoard | null =
    gameState && playerId ? gameState.players[playerId] : null;
  const isMyTurn = !!gameState && !!me && gameState.activePlayerId === me.id;

  // Utility to update & broadcast state
  function updateAndBroadcast(updater: (prev: GameState) => GameState | null) {
    if (!channel) {
      console.warn("No channel yet, cannot broadcast.");
    }
    setGameState((prev) => {
      if (!prev) return prev;
      const updated = updater(prev);
      if (!updated) return prev;
      channel?.send({
        type: "broadcast",
        event: "state",
        payload: updated,
      });
      return updated;
    });
  }

  // ====== Top-level actions ======

  function handleCreateGame() {
    if (!playerName.trim() || !playerId) {
      alert("Please enter your name first.");
      return;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("cardgame_player_name", playerName.trim());
    }
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setInviteCode(code);
    setInviteCodeInput(code);
    setJoinMode("host");
  }

  function handleJoinGame() {
    if (!playerName.trim() || !playerId) {
      alert("Please enter your name first.");
      return;
    }
    if (!inviteCodeInput.trim()) {
      alert("Please enter an invite code.");
      return;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("cardgame_player_name", playerName.trim());
    }
    setInviteCode(inviteCodeInput.trim().toUpperCase());
    setJoinMode("join");
  }

  function handleStartGame() {
    if (!gameState || !me || !me.isHost) {
      alert("Only host can start the game.");
      return;
    }
    if (!channel) {
      alert("Channel not ready yet. Try again in a moment.");
      return;
    }

    updateAndBroadcast((prev) => {
      const playerIds = prev.playerOrder;
      if (playerIds.length < 2 || playerIds.length > 5) {
        alert("You need 2 to 5 players to start.");
        return prev;
      }

      const firstPlayerId = chosenFirstPlayerId || playerIds[0];

      const deckAll = generateDeck();
      const playersCopy: Record<string, PlayerBoard> = {};
      let deckIndex = 0;

      // deal 21 cards to each player's first row
      for (const pid of playerIds) {
        const p = prev.players[pid];
        const handRow: PlayerRow = Array(22).fill(null);
        const tableRow: PlayerRow = Array(22).fill(null);

        for (let i = 0; i < 21; i++) {
          handRow[i] = deckAll[deckIndex++];
        }

        playersCopy[pid] = {
          ...p,
          handRow,
          tableRow,
          submitted: false,
          finished: false,
        };
      }

      // choose trump (non-joker) from remaining deck
      let trumpCard: Card | null = null;
      while (deckIndex < deckAll.length && !trumpCard) {
        const candidate = deckAll[deckIndex];
        if (candidate.suit !== "joker") {
          trumpCard = candidate;
          deckIndex++;
        } else {
          break;
        }
      }

      // one open card on discard pile
      const discardPile: Card[] = [];
      discardPile.push(deckAll[deckIndex++]);

      const remainingDeck = deckAll.slice(deckIndex);

      const newState: GameState = {
        ...prev,
        players: playersCopy,
        deck: remainingDeck,
        discardPile,
        status: "playing",
        activePlayerId: firstPlayerId,
        hasDrawnThisTurn: false,
        hasDiscardedThisTurn: false,
        lastDiscardInfo: {
          ownerId: null,
          fromRow: null,
          fromIndex: null,
          faceDown: false,
        },
        trumpCard,
        trumpViewers: [],
        pendingTrumpRequest: null,
      };

      return newState;
    });
  }

  function handleHostNewGame() {
    if (!gameState || !me || !me.isHost) return;

    updateAndBroadcast((prev) => {
      const players: Record<string, PlayerBoard> = {};
      for (const pid of Object.keys(prev.players)) {
        const p = prev.players[pid];
        players[pid] = {
          ...p,
          handRow: Array(22).fill(null),
          tableRow: Array(22).fill(null),
          submitted: false,
          finished: false,
        };
      }

      const newState: GameState = {
        ...prev,
        status: "lobby",
        deck: [],
        discardPile: [],
        players,
        lastDiscardInfo: {
          ownerId: null,
          fromRow: null,
          fromIndex: null,
          faceDown: false,
        },
        hasDrawnThisTurn: false,
        hasDiscardedThisTurn: false,
        activePlayerId: prev.hostId,
        trumpCard: null,
        trumpViewers: [],
        pendingTrumpRequest: null,
      };

      return newState;
    });
  }

  // ====== Turn actions (draw, take from discard, discard, undo, finish, end turn) ======

  function handleDrawFromDeck() {
    if (!gameState || !playerId) return;
    if (!isMyTurn) {
      alert("It's not your turn to draw.");
      return;
    }

    updateAndBroadcast((prev) => {
      if (prev.hasDrawnThisTurn) {
        alert("You already drew a card this turn.");
        return prev;
      }
      if (prev.deck.length === 0) {
        alert("Deck is empty.");
        return prev;
      }

      const deck = [...prev.deck];
      const card = deck.pop() as Card;

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      const handRow = [...myBoard.handRow];

      const emptyIndex = handRow.findIndex((c) => c === null);
      if (emptyIndex === -1) {
        handRow[handRow.length - 1] = card;
      } else {
        handRow[emptyIndex] = card;
      }

      myBoard.handRow = handRow;
      players[playerId] = myBoard;

      return {
        ...prev,
        deck,
        players,
        hasDrawnThisTurn: true,
      };
    });
  }

  function handleTakeFromDiscard() {
    if (!gameState || !playerId) return;
    if (!isMyTurn) {
      alert("It's not your turn to draw.");
      return;
    }

    updateAndBroadcast((prev) => {
      if (prev.hasDrawnThisTurn) {
        alert("You already drew a card this turn.");
        return prev;
      }
      if (prev.discardPile.length === 0) {
        return prev;
      }

      const discardPile = [...prev.discardPile];
      const card = discardPile.pop() as Card;

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      const handRow = [...myBoard.handRow];

      const emptyIndex = handRow.findIndex((c) => c === null);
      if (emptyIndex === -1) {
        handRow[handRow.length - 1] = card;
      } else {
        handRow[emptyIndex] = card;
      }

      myBoard.handRow = handRow;
      players[playerId] = myBoard;

      return {
        ...prev,
        discardPile,
        players,
        hasDrawnThisTurn: true,
        lastDiscardInfo: {
          ownerId: null,
          fromRow: null,
          fromIndex: null,
          faceDown: false,
        },
      };
    });
  }

  function handleDiscardCard(fromRow: "hand" | "table", index: number) {
    if (!gameState || !playerId) return;
    if (!isMyTurn) {
      alert("It's not your turn to discard.");
      return;
    }

    updateAndBroadcast((prev) => {
      if (prev.hasDiscardedThisTurn) {
        alert(
          "You have already discarded this turn. Use Undo discard if needed."
        );
        return prev;
      }

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      let handRow = [...myBoard.handRow];
      let tableRow = [...myBoard.tableRow];
      const discardPile = [...prev.discardPile];

      if (fromRow === "hand") {
        const card = handRow[index];
        if (!card) return prev;
        handRow.splice(index, 1);
        handRow.push(null);
        discardPile.push(card);
      } else {
        const card = tableRow[index];
        if (!card) return prev;
        tableRow.splice(index, 1);
        tableRow.push(null);
        discardPile.push(card);
      }

      myBoard.handRow = handRow;
      myBoard.tableRow = tableRow;
      players[playerId] = myBoard;

      return {
        ...prev,
        players,
        discardPile,
        hasDiscardedThisTurn: true,
        lastDiscardInfo: {
          ownerId: playerId,
          fromRow,
          fromIndex: index,
          faceDown: false,
        },
      };
    });
  }

  function handleUndoDiscard() {
    if (!gameState || !playerId) return;
    if (!isMyTurn) {
      alert("It's not your turn.");
      return;
    }

    updateAndBroadcast((prev) => {
      const info = prev.lastDiscardInfo;
      if (!info.ownerId || info.ownerId !== playerId || info.faceDown) {
        return prev;
      }

      const discardPile = [...prev.discardPile];
      if (discardPile.length === 0) return prev;

      const card = discardPile.pop() as Card;

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      let handRow = [...myBoard.handRow];
      let tableRow = [...myBoard.tableRow];

      if (info.fromRow === "hand" && info.fromIndex != null) {
        handRow.splice(info.fromIndex, 0, card);
        handRow.pop();
      } else if (info.fromRow === "table" && info.fromIndex != null) {
        tableRow.splice(info.fromIndex, 0, card);
        tableRow.pop();
      } else {
        const idx = handRow.findIndex((c) => c === null);
        if (idx === -1) {
          handRow[handRow.length - 1] = card;
        } else {
          handRow[idx] = card;
        }
      }

      myBoard.handRow = handRow;
      myBoard.tableRow = tableRow;
      players[playerId] = myBoard;

      return {
        ...prev,
        players,
        discardPile,
        hasDiscardedThisTurn: false,
        lastDiscardInfo: {
          ownerId: null,
          fromRow: null,
          fromIndex: null,
          faceDown: false,
        },
      };
    });
  }

  function handleSubmitSecondLine() {
    if (!gameState || !playerId) return;

    updateAndBroadcast((prev) => {
      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      myBoard.submitted = true;
      players[playerId] = myBoard;
      return { ...prev, players };
    });
  }

  function handleUndoSubmitSecondLine() {
    if (!gameState || !playerId) return;

    updateAndBroadcast((prev) => {
      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      myBoard.submitted = false;
      players[playerId] = myBoard;
      return { ...prev, players };
    });
  }

  function handleDeclareFinish() {
    if (!gameState || !playerId) return;

    updateAndBroadcast((prev) => {
      if (prev.discardPile.length === 0) {
        alert("You must have at least one card in discard pile.");
        return prev;
      }

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      myBoard.finished = true;
      players[playerId] = myBoard;

      return {
        ...prev,
        players,
        status: "finished",
        lastDiscardInfo: {
          ...prev.lastDiscardInfo,
          faceDown: true,
        },
      };
    });
  }

  function handleUndoFinish() {
    if (!gameState || !playerId) return;

    updateAndBroadcast((prev) => {
      const info = prev.lastDiscardInfo;
      if (!info.faceDown || info.ownerId !== playerId) {
        return prev;
      }

      const discardPile = [...prev.discardPile];
      if (discardPile.length === 0) return prev;

      const card = discardPile.pop() as Card;

      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };
      let handRow = [...myBoard.handRow];
      let tableRow = [...myBoard.tableRow];

      if (info.fromRow === "hand" && info.fromIndex != null) {
        handRow.splice(info.fromIndex, 0, card);
        handRow.pop(); // keep 22 slots
      } else if (info.fromRow === "table" && info.fromIndex != null) {
        tableRow.splice(info.fromIndex, 0, card);
        tableRow.pop();
      } else {
        const idx = handRow.findIndex((c) => c === null);
        if (idx === -1) {
          handRow[handRow.length - 1] = card;
        } else {
          handRow[idx] = card;
        }
      }

      myBoard.handRow = handRow;
      myBoard.tableRow = tableRow;
      myBoard.finished = false;
      players[playerId] = myBoard;

      return {
        ...prev,
        players,
        discardPile,
        status: "playing",
        lastDiscardInfo: {
          ownerId: null,
          fromRow: null,
          fromIndex: null,
          faceDown: false,
        },
      };
    });
  }

  // explicit "End turn" button
  function handleEndTurn() {
    if (!gameState || !playerId) return;
    if (!isMyTurn) {
      alert("It's not your turn.");
      return;
    }

    updateAndBroadcast((prev) => {
      const meBoard = prev.players[playerId];
      if (!meBoard) return prev;

      // Count total non-null cards across both rows
      const totalCards = [...meBoard.handRow, ...meBoard.tableRow].filter(
        (c) => c !== null
      ).length;

      // Rule: cannot end turn with more than 21 cards
      if (totalCards > 21) {
        alert(
          `You cannot end your turn while holding more than 21 cards. ` +
            `You currently have ${totalCards} cards.`
        );
        return prev;
      }

      // Optional: warning if they haven't discarded
      if (!prev.hasDiscardedThisTurn) {
        const proceed = window.confirm(
          "You have not discarded a card this turn. End turn anyway?"
        );
        if (!proceed) return prev;
      }

      return advanceTurn(prev);
    });
  }

  // ====== Trump request / approve / reject ======

  function handleRequestTrump() {
    if (!gameState || !me) return;
    if (!isMyTurn) {
      alert("You can only request trump on your turn.");
      return;
    }
    if (!gameState.trumpCard) {
      alert("No trump card set.");
      return;
    }

    updateAndBroadcast((prev) => {
      // Do not stack multiple *pending* requests
      if (
        prev.pendingTrumpRequest &&
        prev.pendingTrumpRequest.status === "pending"
      ) {
        if (prev.pendingTrumpRequest.requesterId === me.id) {
          alert("You already have a pending trump request.");
        }
        return prev;
      }

      // If this player already sees trump, no need to request
      if (prev.trumpViewers.includes(me.id)) return prev;

      let approverId: string;
      if (me.isHost) {
        const idx = prev.playerOrder.indexOf(me.id);
        const nextIdx = (idx + 1) % prev.playerOrder.length;
        approverId = prev.playerOrder[nextIdx];
      } else {
        approverId = prev.hostId;
      }

      const req: TrumpRequest = {
        requesterId: me.id,
        approverId,
        status: "pending",
      };

      return {
        ...prev,
        pendingTrumpRequest: req,
      };
    });
  }

  function handleApproveTrump() {
    if (!gameState || !me) return;

    updateAndBroadcast((prev) => {
      const req = prev.pendingTrumpRequest;
      if (
        !req ||
        req.approverId !== me.id ||
        req.status !== "pending" ||
        !prev.trumpCard
      ) {
        return prev;
      }

      const viewers = prev.trumpViewers.includes(req.requesterId)
        ? prev.trumpViewers
        : [...prev.trumpViewers, req.requesterId];

      return {
        ...prev,
        trumpViewers: viewers,
        pendingTrumpRequest: {
          ...req,
          status: "approved",
        },
      };
    });
  }

  function handleRejectTrump() {
    if (!gameState || !me) return;

    updateAndBroadcast((prev) => {
      const req = prev.pendingTrumpRequest;
      if (!req || req.approverId !== me.id || req.status !== "pending") {
        return prev;
      }

      return {
        ...prev,
        pendingTrumpRequest: {
          ...req,
          status: "rejected",
        },
      };
    });
  }

  // ====== Drag & drop / tap between rows ======

  function handleMoveCardDrop(
    targetRow: "hand" | "table",
    targetIndex: number
  ) {
    if (!gameState || !playerId || !dragInfo) return;

    const fromRow = dragInfo.fromRow;
    const fromIndex = dragInfo.fromIndex;

    if (fromRow === targetRow && fromIndex === targetIndex) {
      setDragInfo(null);
      return;
    }

    updateAndBroadcast((prev) => {
      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };

      let handRow = [...myBoard.handRow];
      let tableRow = [...myBoard.tableRow];

      if (fromRow === "hand" && targetRow === "hand") {
        handRow = moveWithinRow(handRow, fromIndex, targetIndex);
      } else if (fromRow === "table" && targetRow === "table") {
        tableRow = moveWithinRow(tableRow, fromIndex, targetIndex);
      } else if (fromRow === "hand" && targetRow === "table") {
        const res = moveBetweenRows(handRow, tableRow, fromIndex, targetIndex);
        handRow = res.newFrom;
        tableRow = res.newTo;
      } else if (fromRow === "table" && targetRow === "hand") {
        const res = moveBetweenRows(tableRow, handRow, fromIndex, targetIndex);
        tableRow = res.newFrom;
        handRow = res.newTo;
      }

      myBoard.handRow = handRow;
      myBoard.tableRow = tableRow;
      players[playerId] = myBoard;

      return {
        ...prev,
        players,
      };
    });

    setDragInfo(null);
  }

  // tap-to-move (touch-friendly) – pick card then tap destination slot
  function handleCardTap(
    rowName: "hand" | "table",
    index: number,
    card: Card | null,
    isMine: boolean
  ) {
    if (!gameState || !playerId || !isMine) return;

    // If nothing selected yet, tap on a card to select it
    if (!tapSelection) {
      if (!card) return;
      setTapSelection({ fromRow: rowName, fromIndex: index });
      return;
    }

    // If tapping the same slot again, cancel selection
    if (tapSelection.fromRow === rowName && tapSelection.fromIndex === index) {
      setTapSelection(null);
      return;
    }

    // We have a selected card and tapped a target slot
    const fromRow = tapSelection.fromRow;
    const fromIndex = tapSelection.fromIndex;
    const targetRow = rowName;
    const targetIndex = index;

    updateAndBroadcast((prev) => {
      const players = { ...prev.players };
      const myBoard = { ...players[playerId] };

      let handRow = [...myBoard.handRow];
      let tableRow = [...myBoard.tableRow];

      if (fromRow === "hand" && targetRow === "hand") {
        handRow = moveWithinRow(handRow, fromIndex, targetIndex);
      } else if (fromRow === "table" && targetRow === "table") {
        tableRow = moveWithinRow(tableRow, fromIndex, targetIndex);
      } else if (fromRow === "hand" && targetRow === "table") {
        const res = moveBetweenRows(handRow, tableRow, fromIndex, targetIndex);
        handRow = res.newFrom;
        tableRow = res.newTo;
      } else if (fromRow === "table" && targetRow === "hand") {
        const res = moveBetweenRows(tableRow, handRow, fromIndex, targetIndex);
        tableRow = res.newFrom;
        handRow = res.newTo;
      }

      myBoard.handRow = handRow;
      myBoard.tableRow = tableRow;
      players[playerId] = myBoard;

      return { ...prev, players };
    });

    setTapSelection(null);
  }

  // ====== Rendering helpers ======

  function renderCardFace(card: Card) {
    // Joker = full image
    if (card.suit === "joker") {
      return (
        <div className="joker-card">
          {card.jokerImage && (
            <img
              src={card.jokerImage}
              alt="Joker"
              className="joker-image-full"
            />
          )}
        </div>
      );
    }

    let symbol = "♠";
    if (card.suit === "hearts") symbol = "♥";
    if (card.suit === "diamonds") symbol = "♦";
    if (card.suit === "clubs") symbol = "♣";

    return (
      <div className="card-layout">
        <div className="card-corner card-corner-top">
          <span className="card-rank">{card.rank}</span>
        </div>
        <div className="card-center-suit">{symbol}</div>
        <div className="card-corner card-corner-bottom">
          <span className="card-rank">{card.rank}</span>
        </div>
      </div>
    );
  }

  function cardSlot(
    rowName: "hand" | "table",
    index: number,
    card: Card | null,
    isMine: boolean
  ) {
    const isDraggable = isMine && !!card;
    const isJoker = !!card && card.suit === "joker";

    const selected =
      tapSelection &&
      tapSelection.fromRow === rowName &&
      tapSelection.fromIndex === index;

    return (
      <div
        key={`${rowName}-${index}-${card?.id || "empty"}`}
        className="card-slot"
        draggable={isDraggable}
        onDragStart={() => {
          if (isDraggable) {
            setDragInfo({ fromRow: rowName, fromIndex: index });
          }
        }}
        onDragOver={(e) => {
          if (dragInfo && isMine) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragInfo && isMine) {
            handleMoveCardDrop(rowName, index);
          }
        }}
        onClick={() => {
          // tap/click-to-move between rows (touch support)
          handleCardTap(rowName, index, card, isMine);
        }}
        style={
          selected
            ? { outline: "2px solid #2563eb", borderRadius: "12px" }
            : undefined
        }
      >
        {card ? (
          <div
            className={`card ${isJoker ? "joker-card-outer" : ""}`}
            style={
              isJoker
                ? undefined
                : {
                    borderColor: card.color === "red" ? "#e11d48" : "#cbd5f5",
                    color: card.color === "red" ? "#e11d48" : "#111827",
                  }
            }
          >
            {renderCardFace(card)}
          </div>
        ) : (
          <div className="card empty">+</div>
        )}
      </div>
    );
  }

  // ====== derived trump flags ======

  const iSeeTrump =
    !!gameState &&
    !!me &&
    !!gameState.trumpCard &&
    !!gameState.trumpViewers &&
    gameState.trumpViewers.includes(me.id);

  const pendingTrumpForMe =
    gameState &&
    me &&
    gameState.pendingTrumpRequest &&
    gameState.pendingTrumpRequest.approverId === me.id &&
    gameState.pendingTrumpRequest.status === "pending"
      ? gameState.pendingTrumpRequest
      : null;

  const canRequestTrump =
    !!gameState &&
    !!me &&
    gameState.status === "playing" &&
    !!gameState.trumpCard &&
    isMyTurn &&
    !iSeeTrump &&
    (!gameState.pendingTrumpRequest ||
      gameState.pendingTrumpRequest.status !== "pending");

  // ====== JSX UI ======

  const showLandingTopBar = joinMode === "none" && !gameState;
  const showWaitingPanel = joinMode !== "none" && !gameState;

  return (
    <div className="app">
      {/* Landing controls – only before hosting/joining */}
      {showLandingTopBar && (
        <div className="panel">
          <div className="top-bar">
            <div className="stack">
              <div className="title-main">Online Card Game</div>
              <div className="title-sub">
                3 decks + 9 Jokers · 2–5 players · drag &amp; drop
              </div>
              {inviteCode && (
                <div className="room-code">
                  Room code: <b>{inviteCode}</b>
                </div>
              )}
            </div>

            <div className="stack">
              <div className="label">Your name</div>
              <input
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="Enter your name"
              />
            </div>

            <div className="stack">
              <div className="label">Invite code</div>
              <input
                value={inviteCodeInput}
                onChange={(e) =>
                  setInviteCodeInput(e.target.value.toUpperCase())
                }
                placeholder="e.g. ABC123"
              />
            </div>

            <div className="stack">
              <button className="btn" onClick={handleCreateGame}>
                Host new game
              </button>
              <button className="btn secondary" onClick={handleJoinGame}>
                Join game
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Waiting state – prevents blank background for join/host */}
      {showWaitingPanel && (
        <div className="panel panel-soft">
          <div className="top-bar">
            <div className="stack">
              <div className="title-main">Online Card Game</div>
              <div className="title-sub">
                {joinMode === "host"
                  ? "Creating lobby…"
                  : "Joining room… waiting for host"}
              </div>
              <div className="room-code">
                Room code: <b>{inviteCode || inviteCodeInput || "…"}</b>
              </div>
              <div className="label">
                Player: <b>{playerName || "…"}</b>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Game info + piles */}
      {gameState && (
        <div className="panel panel-soft">
          {/* Trump approval popup for approver */}
          {pendingTrumpForMe && (
            <div className="trump-popup">
              <div className="trump-popup-inner">
                <div className="trump-popup-title">Trump request</div>
                <div className="trump-popup-text">
                  Player{" "}
                  <b>{gameState.players[pendingTrumpForMe.requesterId].name}</b>{" "}
                  is requesting to see the trump card.
                </div>
                <div className="trump-popup-actions">
                  <button className="btn small" onClick={handleApproveTrump}>
                    Approve
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={handleRejectTrump}
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* LEFT: info, RIGHT: piles + finish */}
          <div className="game-header-layout">
            {/* LEFT SIDE */}
            <div className="game-header-left">
              <div className="status-line">Status: {gameState.status}</div>

              <div className="room-code-inline">
                Room code: <b>{gameState.inviteCode}</b>
              </div>

              <div className="players-line">
                {gameState.playerOrder.map((pid) => {
                  const p = gameState.players[pid];
                  const isActive = pid === gameState.activePlayerId;
                  return (
                    <div key={pid} className="player-chip">
                      {isActive ? "⭐ " : ""}
                      {p.name}
                      {p.isHost ? " (Host)" : ""}
                      {p.finished ? " ✅" : ""}
                    </div>
                  );
                })}
              </div>

              {gameState.status === "playing" && (
                <div className="turn-line">
                  Turn:{" "}
                  <b>{gameState.players[gameState.activePlayerId].name}</b>
                  {isMyTurn ? " (Your turn)" : ""}
                </div>
              )}

              {/* Host-only controls */}
              {me && me.isHost && (
                <div className="host-controls">
                  {gameState.status === "lobby" && (
                    <>
                      <span className="label small">First player:</span>
                      <select
                        value={chosenFirstPlayerId || gameState.playerOrder[0]}
                        onChange={(e) => setChosenFirstPlayerId(e.target.value)}
                      >
                        {gameState.playerOrder.map((pid) => (
                          <option key={pid} value={pid}>
                            {gameState.players[pid].name}
                          </option>
                        ))}
                      </select>
                      <button className="btn" onClick={handleStartGame}>
                        Start game
                      </button>
                    </>
                  )}

                  <button
                    className="btn secondary host-reset-btn"
                    onClick={handleHostNewGame}
                  >
                    Host: reset to lobby
                  </button>
                </div>
              )}
            </div>

            {/* RIGHT SIDE: piles + finish controls */}
            <div className="pile">
              {/* 🔹 Trump card */}
              <div className="stack center">
                <div className="label">Trump</div>
                <div className="card-slot pile-card">
                  {iSeeTrump && gameState.trumpCard ? (
                    <div
                      className="card"
                      style={{
                        borderColor:
                          gameState.trumpCard.color === "red"
                            ? "#e11d48"
                            : "#cbd5f5",
                        color:
                          gameState.trumpCard.color === "red"
                            ? "#e11d48"
                            : "#111827",
                      }}
                    >
                      {renderCardFace(gameState.trumpCard)}
                    </div>
                  ) : (
                    <button
                      className="card deck-back trump-button"
                      type="button"
                      onClick={() => {
                        if (canRequestTrump) {
                          handleRequestTrump();
                        } else if (!isMyTurn) {
                          alert("You can only request trump on your turn.");
                        }
                      }}
                    >
                      <div className="trump-back-image" />
                    </button>
                  )}
                </div>
                {canRequestTrump && !iSeeTrump && (
                  <button
                    className="btn small"
                    type="button"
                    onClick={handleRequestTrump}
                  >
                    Request trump
                  </button>
                )}
                {iSeeTrump && (
                  <div className="trump-info-small">
                    You have seen the trump.
                  </div>
                )}
              </div>

              {/* 🔹 Draw pile */}
              <div className="stack center">
                <div className="label">Draw pile ({gameState.deck.length})</div>
                <div className="card-slot pile-card">
                  {gameState.deck.length > 0 ? (
                    <div className="card deck-back"></div>
                  ) : (
                    <div className="card empty">0</div>
                  )}
                </div>
                {isMyTurn && (
                  <button className="btn small" onClick={handleDrawFromDeck}>
                    Draw from deck
                  </button>
                )}
              </div>

              {/* 🔹 Discard pile */}
              <div className="stack center">
                <div className="label">
                  Discard pile ({gameState.discardPile.length})
                </div>
                <div
                  className="card-slot pile-card"
                  onDragOver={(e) => {
                    if (dragInfo && isMyTurn) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragInfo && isMyTurn) {
                      handleDiscardCard(dragInfo.fromRow, dragInfo.fromIndex);
                      setDragInfo(null);
                    }
                  }}
                  onClick={() => {
                    // tap-selection to discard (touch): if a card is selected, discard it
                    if (tapSelection && isMyTurn) {
                      handleDiscardCard(
                        tapSelection.fromRow,
                        tapSelection.fromIndex
                      );
                      setTapSelection(null);
                    }
                  }}
                >
                  {gameState.discardPile.length > 0 ? (
                    (() => {
                      const top =
                        gameState.discardPile[gameState.discardPile.length - 1];
                      const faceDown = gameState.lastDiscardInfo.faceDown;
                      if (faceDown) {
                        return <div className="card deck-back"></div>;
                      }
                      const isJoker = top.suit === "joker";
                      return (
                        <div
                          className={`card ${
                            isJoker ? "joker-card-outer" : ""
                          }`}
                          style={
                            isJoker
                              ? undefined
                              : {
                                  borderColor:
                                    top.color === "red" ? "#e11d48" : "#cbd5f5",
                                  color:
                                    top.color === "red" ? "#e11d48" : "#111827",
                                }
                          }
                        >
                          {renderCardFace(top)}
                        </div>
                      );
                    })()
                  ) : (
                    <div className="card empty">+</div>
                  )}
                </div>
                {isMyTurn && (
                  <button className="btn small" onClick={handleTakeFromDiscard}>
                    Take from discard
                  </button>
                )}
              </div>

              {/* 🔹 Finish + undo + end turn */}
              {me && (
                <div className="stack center finish-stack">
                  <div className="label">Finish / turn controls</div>
                  <button
                    className="btn danger"
                    onClick={handleDeclareFinish}
                    disabled={me.finished}
                  >
                    Declare finish
                  </button>
                  <button
                    className="btn secondary"
                    onClick={handleUndoFinish}
                    disabled={
                      !me.finished || !gameState.lastDiscardInfo.faceDown
                    }
                  >
                    Undo finish
                  </button>
                  <button
                    className="btn secondary"
                    onClick={handleUndoDiscard}
                    disabled={
                      !isMyTurn ||
                      !gameState.lastDiscardInfo.ownerId ||
                      gameState.lastDiscardInfo.ownerId !== me.id ||
                      gameState.lastDiscardInfo.faceDown
                    }
                  >
                    Undo discard
                  </button>
                  <button
                    className="btn"
                    onClick={handleEndTurn}
                    disabled={!isMyTurn}
                  >
                    End turn
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* My board */}
      {gameState && me && (
        <div className="panel panel-soft">
          {/* Removed "Your board (name)" line as requested */}

          <div className="row">
            {me.handRow.map((card, idx) => cardSlot("hand", idx, card, true))}
          </div>

          <div className="label second-line-label">
            Second line (visible to others after you submit)
          </div>
          <div
            className={`row line-row ${me.submitted ? "line-submitted" : ""}`}
          >
            {me.tableRow.map((card, idx) => cardSlot("table", idx, card, true))}
          </div>

          <div className="board-footer">
            <button
              className="btn secondary"
              onClick={handleSubmitSecondLine}
              disabled={me.submitted}
            >
              Submit second line
            </button>
            <button
              className="btn secondary"
              onClick={handleUndoSubmitSecondLine}
              disabled={!me.submitted}
            >
              Undo submit
            </button>
          </div>
        </div>
      )}

      {/* Other players */}
      {gameState && me && (
        <div className="panel panel-soft">
          <div className="section-title">Other players</div>

          {gameState.playerOrder
            .filter((pid) => pid !== me.id)
            .map((pid) => {
              const p = gameState.players[pid];
              return (
                <div key={pid} className="other-player-block">
                  <div className="other-player-header">
                    {p.name} {p.isHost ? "(Host)" : ""} {p.finished ? "✅" : ""}
                  </div>
                  <div className="other-player-sub">
                    {p.submitted
                      ? "Second line (visible)"
                      : "Second line (not submitted yet)"}
                  </div>
                  {p.submitted && (
                    <div className="row">
                      {p.tableRow.map((card, idx) =>
                        cardSlot("table", idx, card, false)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};

export default HomePage;
