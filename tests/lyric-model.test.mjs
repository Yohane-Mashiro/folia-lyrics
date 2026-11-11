import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCharacterTimings,
    findActiveLine,
    formatTime,
    normalizeResponse,
    wordState,
} from '../lyricModel.js';

test('normalizes word-by-word Folia responses', () => {
    const lyric = normalizeResponse({
        wordByWord: true,
        title: 'Example',
        artist: 'Singer',
        lines: [{
            text: 'Hello world',
            startTime: 12.4,
            endTime: 15.1,
            words: [
                {text: 'Hello', startTime: 12.4, endTime: 13.5},
                {text: ' world', startTime: 13.5, endTime: 15.1},
            ],
        }],
    });

    assert.equal(lyric.wordByWord, true);
    assert.equal(lyric.lines[0].words[1].text, ' world');
    assert.equal(findActiveLine(lyric, 13), lyric.lines[0]);
    assert.equal(wordState(lyric.lines[0].words[0], 13), 'current');
    assert.equal(wordState(lyric.lines[0].words[0], 14), 'past');
    assert.equal(wordState(lyric.lines[0].words[1], 13), 'future');
});

test('applies a signed millisecond offset', () => {
    const delayed = normalizeResponse({
        offset: 500,
        lines: [{
            text: 'Delayed',
            startTime: 3.2,
            endTime: 7.8,
            words: [{text: 'Delayed', startTime: 3.2, endTime: 4.1}],
        }],
    });

    assert.equal(delayed.lines[0].startTime, 3.7);
    assert.equal(delayed.lines[0].words[0].startTime, 3.7);
    assert.equal(delayed.lines[0].words[0].endTime, 4.6);
    assert.equal(findActiveLine(delayed, 3.5), null);
    assert.equal(findActiveLine(delayed, 3.7), delayed.lines[0]);
});

test('preserves the Folia clip start offset', () => {
    const lyric = normalizeResponse({
        clipStartMs: 32000,
        lines: [{
            text: 'Clip',
            startTime: 35,
            endTime: 40,
        }],
    });

    assert.equal(lyric.clipStartMs, 32000);
});

test('uses per-word timing to build character timing', () => {
    const line = {
        text: 'ABC',
        startTime: 1,
        endTime: 5,
        words: [
            {text: 'A', startTime: 1, endTime: 2},
            {text: 'BC', startTime: 3, endTime: 5},
        ],
    };

    const timings = buildCharacterTimings(line, line.text);
    assert.deepEqual(timings, [
        {startTime: 1, endTime: 2},
        {startTime: 3, endTime: 4},
        {startTime: 4, endTime: 5},
    ]);
});

test('maps word fragments into the full line text', () => {
    const line = {
        text: 'Hello world',
        startTime: 2,
        endTime: 4,
        words: [
            {text: 'Hello', startTime: 2, endTime: 3},
            {text: ' world', startTime: 3, endTime: 4},
        ],
    };

    const timings = buildCharacterTimings(line, line.text);
    assert.equal(timings.length, 11);
    assert.equal(timings[0].startTime, 2);
    assert.equal(timings[10].endTime, 4);
});

test('builds a line-timed translation model', () => {
    const lyric = normalizeResponse({
        lines: [{
            text: 'Original',
            translation: '  Translation',
            startTime: 4,
            endTime: 7,
            words: [{text: 'Original', startTime: 4, endTime: 7}],
        }],
    });
    const line = lyric.lines[0];

    assert.equal(line.translation, 'Translation');
    assert.equal(line.translationWords[0].startTime, 4);
    assert.equal(line.translationWords[0].endTime, 7);
});

test('keeps the previous line visible between lines', () => {
    const lyric = normalizeResponse({
        lines: [
            {text: 'Previous', startTime: 1, endTime: 2},
            {text: 'Next', startTime: 4, endTime: 5},
        ],
    });

    assert.equal(findActiveLine(lyric, 3).text, 'Previous');
    assert.equal(findActiveLine(lyric, 4).text, 'Next');
});

test('rejects malformed payloads and sorts valid lines', () => {
    assert.equal(normalizeResponse(null), null);
    assert.equal(normalizeResponse({}), null);

    const lyric = normalizeResponse({
        lines: [
            null,
            {text: 'later', startTime: 4, endTime: 5},
            {text: 'earlier', startTime: 1, endTime: 2},
            {text: '', startTime: 0, endTime: 1},
        ],
    });
    assert.deepEqual(lyric.lines.map(line => line.text),
        ['earlier', 'later']);
});

test('formats and clamps track times', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(83.9), '1:23');
    assert.equal(formatTime(3600), '60:00');
    assert.equal(formatTime(-1), '0:00');
    assert.equal(formatTime(Number.NaN), '0:00');
});
