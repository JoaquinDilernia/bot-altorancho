import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveQuery } from './liveQuery.js';

function fakeQuery() {
  const state = { gets: 0, onNext: null, onError: null, listens: 0 };
  const query = {
    get: async () => { state.gets++; return { docs: ['from-get'] }; },
    onSnapshot: (next, error) => {
      state.listens++;
      state.onNext = next;
      state.onError = error;
      return () => {};
    },
  };
  return { state, build: () => query };
}

test('usa .get() hasta que llega el primer snapshot', async () => {
  const { state, build } = fakeQuery();
  const lq = createLiveQuery(build, 't');
  assert.deepEqual(await lq.getDocs(), ['from-get']);
  assert.equal(state.gets, 1);
  assert.equal(state.listens, 1);
});

test('después del snapshot sirve de memoria sin leer Firestore', async () => {
  const { state, build } = fakeQuery();
  const lq = createLiveQuery(build, 't');
  await lq.getDocs();
  state.onNext({ docs: ['a', 'b'] });
  assert.deepEqual(await lq.getDocs(), ['a', 'b']);
  state.onNext({ docs: ['c'] });
  assert.deepEqual(await lq.getDocs(), ['c']);
  assert.equal(state.gets, 1);
  assert.equal(state.listens, 1);
});

test('si el listener falla vuelve a .get()', async () => {
  const { state, build } = fakeQuery();
  const lq = createLiveQuery(build, 't');
  await lq.getDocs();
  state.onNext({ docs: ['a'] });
  const origError = console.error;
  console.error = () => {};
  state.onError(new Error('boom'));
  console.error = origError;
  assert.deepEqual(await lq.getDocs(), ['from-get']);
  assert.equal(state.gets, 2);
});
