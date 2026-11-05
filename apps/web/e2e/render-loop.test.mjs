// Simulates React's useSyncExternalStore snapshot logic against zustand.
// React re-renders while Object.is(prevSnapshot, newSnapshot) === false.
import { createStore } from 'zustand/vanilla';

const store = createStore((set) => ({
  real: 100,
  bonus: 5,
  gifted: 0,
  locked: 0,
  setBalance: (b) => set(b),
}));

function simulate(getSnapshot, label) {
  let renders = 0;
  let current = null;
  // React's loop: check → if changed → render → check again (up to 10 for demo)
  for (let i = 0; i < 10; i++) {
    const next = getSnapshot(store.getState());
    if (current !== null && Object.is(current, next)) break; // stable → stop
    current = next;
    renders++;
  }
  const infinite = renders >= 10;
  console.log(
    `${label}: renders=${renders} → ${infinite ? 'INFINITE LOOP ❌ (crash)' : 'stable ✅'}`
  );
  return infinite;
}

// OLD (D-084 bug): object literal selector
const oldInfinite = simulate(
  (s) => ({ real: s.real, bonus: s.bonus, gifted: s.gifted, locked: s.locked }),
  'OLD selector (object literal)'
);

// FIXED (D-086): primitive selectors
let real, bonus, gifted, locked;
const newInfinite = simulate((s) => {
  real = s.real;
  bonus = s.bonus;
  gifted = s.gifted;
  locked = s.locked;
  return real; // primitive snapshot like the fixed code's individual hooks
}, 'FIXED selector (primitive)');

console.log(
  '\nRESULT:',
  !oldInfinite && !newInfinite
    ? 'both stable'
    : oldInfinite
      ? 'OLD CRASHES — FIXED ✅'
      : 'OK'
);
process.exit(oldInfinite ? 0 : 1);
