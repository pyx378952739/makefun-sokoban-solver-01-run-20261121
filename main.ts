// A push-optimal Sokoban solver: each level is a hallway with small rooms off
// it, and a box never leaves its room in an optimal answer, so every room is
// solved on its own with A* over pushes and the answers are joined by walks.
// A state is the boxes' squares and the player's reachable region (named by
// its lowest square); the estimate is the cheapest assignment of boxes to
// goals on walking distances, so the first solved state popped is optimal.
// Dead squares (no push, boxes aside, ever reaches a goal) and frozen 2x2
// blocks are pruned; neither prunes a solvable state. Pure: no clock, no
// randomness, fixed orders everywhere, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps: dx, dy, the walk letter, the push letter.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one search may keep before it gives up: work, never time.
const ROOM_STATES = 400_000;
const WHOLE_STATES = 600_000;

type Board = { w: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** A level in XSB, read onto a board padded with a wall border (so every neighbour lookup stays in range). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const W = w + 2;
  const wall = new Uint8Array(W * (h + 2)).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = (y + 1) * W + (x + 1);
      if (ch === '#') continue;
      wall[i] = 0;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  return { w: W, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from `from` over open floor (-1 where unreachable). */
function walkDist(wall: Uint8Array, from: number, w: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** The squares the player reaches from `from` around walls and the boxes in `occ`; marks them in `seen` with `stamp`, returns the lowest. */
function reach(wall: Uint8Array, occ: Uint8Array, from: number, w: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(wall: Uint8Array, occ: Uint8Array, goal: Uint8Array, t: number, w: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(wall: Uint8Array, occ: Uint8Array, from: number, to: number, w: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal answer of a board ({wall, w, goals, boxes, player}), or
 * null when the search gives up (or the board has no answer). `greedy` runs
 * best-first on the estimate alone: any answer, not necessarily optimal.
 */
function solvePush(b: Board, maxStates: number, greedy: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = b;
  const size = wall.length;
  const n = b.boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  if (b.boxes.some((x) => !live[x])) return null;
  const solved = (bs: number[]): boolean => bs.every((x) => goal[x]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };
  // Walking distance from every cell to each goal, for the estimate.
  const distG = goals.map((g) => walkDist(wall, g, w));
  // The cheapest assignment of boxes to goals (exact by bitmask DP while the
  // boxes are few, else the sum of each box's nearest goal); -1 where a box
  // reaches no goal at all. Consistent: one push moves one box one square.
  const estimate = (bs: number[]): number => {
    if (n <= 5) {
      const full = (1 << n) - 1;
      const dp = new Float64Array(1 << n).fill(Infinity);
      dp[0] = 0;
      for (let mask = 0; mask <= full; mask++) {
        const i = popcount(mask);
        if (i >= n || dp[mask] === Infinity) continue;
        for (let g = 0; g < n; g++) {
          if (mask & (1 << g)) continue;
          const d = distG[g]![bs[i]!]!;
          if (d < 0) continue;
          const nm = mask | (1 << g);
          const v = dp[mask]! + d;
          if (v < dp[nm]!) dp[nm] = v;
        }
      }
      return dp[full]!;
    }
    let s = 0;
    for (const x of bs) {
      let m = Infinity;
      for (const dg of distG) {
        const d = dg[x]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
  const numeric = n <= 5;
  const keyOf = (bs: number[], low: number): number | string => {
    if (!numeric) return `${low}:${bs.join(',')}`;
    let k = low;
    for (const x of bs) k = k * size + x;
    return k;
  };
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The states in order found: boxes, the player's square after the push that
  // made them, parent, the push's direction, pushes so far; the open list a
  // heap on pushes + estimate (deeper first on ties, then first found), each
  // entry carrying its pushes so a superseded entry is recognised as stale.
  const stBoxes: number[][] = [b.boxes.slice()];
  const stPlayer: number[] = [b.player];
  const stParent: number[] = [-1];
  const stPush: number[] = [-1];
  const stG: number[] = [0];
  const best = new Map<number | string, number>();
  for (const x of b.boxes) occ[x] = 1;
  const low0 = reach(wall, occ, b.player, w, seen, ++stamp, stack);
  for (const x of b.boxes) occ[x] = 0;
  best.set(keyOf(b.boxes, low0), 0);
  const heap: [number, number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number, number], c: [number, number, number, number, number]): boolean =>
    a[0] < c[0] || (a[0] === c[0] && (a[1] < c[1] || (a[1] === c[1] && a[2] < c[2])));
  const heapPush = (e: [number, number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([estimate(b.boxes), 0, seq++, 0, 0]);
  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, , , s, g] = heapPop();
    if (g !== stG[s]) continue; // superseded: this state has a shorter path now
    const bs = stBoxes[s]!;
    if (solved(bs)) {
      found = s;
      break;
    }
    for (const x of bs) occ[x] = 1;
    const here = ++stamp;
    reach(wall, occ, stPlayer[s]!, w, seen, here, stack);
    for (let bi = 0; bi < n && found < 0; bi++) {
      const box = bs[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const from = box - d;
        const t = box + d;
        if (seen[from] !== here || wall[t] || occ[t] || !live[t]) continue;
        occ[box] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(wall, occ, goal, t, w);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const nlow = reach(wall, occ, box, w, mark, ++stamp, stack);
          key = keyOf(next, nlow);
        }
        occ[t] = 0;
        occ[box] = 1;
        if (frozen || next === null) continue;
        const g2 = stG[s]! + 1;
        const prevIdx = best.get(key);
        if (prevIdx !== undefined && stG[prevIdx]! <= g2) continue;
        const h = estimate(next);
        if (h === Infinity) continue;
        if (prevIdx !== undefined) {
          // A shorter path to a known state: rewrite it in place; its older
          // heap entry is stale and will be skipped when popped.
          stBoxes[prevIdx] = next;
          stPlayer[prevIdx] = box;
          stParent[prevIdx] = s;
          stPush[prevIdx] = k;
          stG[prevIdx] = g2;
          heapPush([greedy ? h : g2 + h, -g2, seq++, prevIdx, g2]);
        } else {
          if (stBoxes.length >= maxStates) return null;
          best.set(key, stBoxes.length);
          stBoxes.push(next);
          stPlayer.push(box);
          stParent.push(s);
          stPush.push(k);
          stG.push(g2);
          heapPush([greedy ? h : g2 + h, -g2, seq++, stBoxes.length - 1, g2]);
        }
      }
    }
    for (const x of bs) occ[x] = 0;
  }
  if (found < 0) return null;
  // The push path, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const nextBoxes = stBoxes[s]!;
    const from = boxes.find((x) => !nextBoxes.includes(x))!;
    const to = nextBoxes.find((x) => !boxes.includes(x))!;
    const k = stPush[s]!;
    const d = DIRS[k]![1] * w + DIRS[k]![0];
    if (to - from !== d) throw new Error('solvePush: the push path does not line up');
    for (const x of boxes) occ[x] = 1;
    moves += walkTo(wall, occ, player, from - d, w);
    for (const x of boxes) occ[x] = 0;
    moves += DIRS[k]![3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

type Room = { boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(b: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = b;
  const live = liveSquares(wall, goals, w);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const x of boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The level's answer: each room solved push-optimally in turn, the other rooms' boxes standing as walls. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let failed = false;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
      }
      const sub: Board = { w: level.w, wall, goals: room.goals.slice().sort((a, b) => a - b), boxes: room.boxes.slice().sort((a, b) => a - b), player };
      const solved = solvePush(sub, ROOM_STATES, false) ?? solvePush(sub, ROOM_STATES, true);
      if (solved === null) {
        failed = true;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    if (!failed) return moves;
    // A room would not solve: the cut may have been the wrong shape for
    // this level, so try one search over the whole level before giving up.
  }
  // No rooms to cut, or a room would not solve: one search over the whole level instead.
  const solved = solvePush(level, WHOLE_STATES, false) ?? solvePush(level, WHOLE_STATES, true);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
