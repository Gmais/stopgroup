import assert from 'node:assert/strict';
import { startsWithLetter, normalizeText, applySettingsPatch, defaultSettings } from '../server/logic.js';

assert.ok(startsWithLetter('  maçã', 'M'), 'ignora espaços e caixa');
assert.ok(startsWithLetter('Água', 'A'), 'sem modo estrito, acento é ignorado');
assert.ok(!startsWithLetter('Água', 'A', true), 'modo estrito considera acento');
assert.ok(startsWithLetter('Ágata', 'Á', true));
assert.ok(!startsWithLetter('', 'A') && !startsWithLetter('1abc', 'A'));
assert.equal(normalizeText('  Maçã   Verde '), 'maca verde');
assert.equal(normalizeText('  Maçã ', true), 'maçã');
const s = applySettingsPatch(defaultSettings(), { timerSec: 99999, endModes: ['x'], scoring: { unique: 20 }, enabledLetters: ['A', 'b', '$'] });
assert.equal(s.timerSec, 900); assert.deepEqual(s.endModes, ['manual']); assert.deepEqual(applySettingsPatch(s, { endModes: ['timer', 'manual'] }).endModes, ['manual', 'timer']); assert.equal(s.scoring.unique, 20);
assert.deepEqual(s.enabledLetters, ['A']);
console.log('logic.test: ok');
